// @ziner/agent-office — Office Agent (P2-2).
//
// Creates and edits Word, Excel and PowerPoint files based on natural
// language instructions. Uses docx / xlsx / pptxgenjs when available;
// falls back to plain-text/markdown output if the libraries are not
// installed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  IAgent,
  ILLMProvider,
  ModelSpec,
  TaskContext,
  AgentResult,
} from '@ziner/contracts';
import { ok as okResult, fail as failResult, parseJsonObject, callWithMetrics } from '@ziner/contracts';

export interface OfficeAgentConfig {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Directory where generated office files are written. */
  outputDir: string;
  /** Max tokens for content generation. Default 2048. */
  maxTokens?: number;
}

export interface WordSection {
  heading?: string;
  paragraphs?: string[];
}

export interface WordContent {
  sections: WordSection[];
}

export interface ExcelSheet {
  name: string;
  headers?: string[];
  rows?: unknown[][];
}

export interface ExcelContent {
  sheets: ExcelSheet[];
}

export interface PptSlide {
  title?: string;
  subtitle?: string;
  bullets?: string[];
}

export interface PptContent {
  slides: PptSlide[];
}

export type OfficeContent = WordContent | ExcelContent | PptContent;

export interface OfficeTask {
  type: 'word' | 'excel' | 'ppt' | 'unknown';
  title: string;
  description?: string;
  content: OfficeContent | unknown;
  /** Internal marker: task was resolved by the fast-path regex, no LLM used. */
  __fastPath?: boolean;
}

export interface OfficeResult {
  fileType: string;
  filePath: string;
  fallback?: boolean;
  note?: string;
}

const OFFICE_KEYWORDS = [
  'word', 'docx', '文档', 'word文档', '报告',
  'excel', 'xlsx', '表格', 'sheet', 'csv',
  'ppt', 'pptx', 'powerpoint', '幻灯片', 'presentation',
  'office',
];

const OFFICE_PARSE_PROMPT = `You are an office document generator. Given a user request, decide which file type to create and extract the structured content.

Respond with a single JSON object:
{
  "type": "word|excel|ppt",
  "title": "document title",
  "description": "optional short description",
  "content": {
    // For word:
    "sections": [
      { "heading": "Section 1", "paragraphs": ["para 1", "para 2"] }
    ],
    // For excel:
    "sheets": [
      { "name": "Sheet1", "headers": ["A", "B"], "rows": [[1, 2], [3, 4]] }
    ],
    // For ppt:
    "slides": [
      { "title": "Slide 1", "bullets": ["point 1", "point 2"] }
    ]
  }
}

Rules:
- Infer the most appropriate type from the user's wording.
- Keep content concise but useful.
- Do not wrap the JSON in markdown.`;

export function createOfficeAgent(config: OfficeAgentConfig): IAgent {
  const { llmProvider, model, outputDir, maxTokens = 2048 } = config;

  return {
    name: 'office',
    role: 'Office Document Generation',
    capabilities: ['office', 'word', 'excel', 'powerpoint', 'document'],
    dependencies: [],
    modelPreference: model,

    canHandle(ctx: TaskContext): number {
      const t = ctx.task.toLowerCase();
      let score = 0;
      for (const k of OFFICE_KEYWORDS) {
        if (t.includes(k.toLowerCase())) score += 0.22;
      }
      return Math.min(score, 0.95);
    },

    async execute(ctx: TaskContext): Promise<AgentResult> {
      const t0 = Date.now();
      try {
        const fastPathTask = tryFastPath(ctx.task);
        let task: OfficeTask;
        let tokensIn = 0;
        let tokensOut = 0;
        let costUsd = 0;
        let llmCalls = 0;

        if (fastPathTask) {
          task = fastPathTask;
        } else {
          const parsed = await parseTask(ctx.task);
          task = parsed.task;
          tokensIn = parsed.tokensIn;
          tokensOut = parsed.tokensOut;
          costUsd = parsed.costUsd;
          llmCalls = 1;
        }

        if (task.type === 'unknown') {
          return failResult('OFFICE_UNKNOWN_TYPE', 'Could not determine office file type from task.');
        }

        const editResult = await tryEditExistingFile(ctx.task, outputDir);
        const result = editResult ?? (await generateOfficeFile(task, outputDir, { llmProvider, model, maxTokens }));
        return okResult(result, {
          metrics: {
            tokensIn,
            tokensOut,
            costUsd,
            durationMs: Date.now() - t0,
            llmCalls,
            toolCalls: 0,
          },
        });
      } catch (err: unknown) {
        return failResult('OFFICE_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  };

  function tryFastPath(rawTask: string): OfficeTask | null {
    const lowered = rawTask.toLowerCase();
    let type: OfficeTask['type'] = 'unknown';
    if (/\b(word|docx|文档)\b/.test(lowered)) type = 'word';
    else if (/\b(excel|xlsx|表格|csv)\b/.test(lowered)) type = 'excel';
    else if (/\b(ppt|pptx|powerpoint|幻灯片|presentation)\b/.test(lowered)) type = 'ppt';
    if (type === 'unknown') return null;

    // Extract title from quotes, Chinese book-title marks, or common patterns.
    const titleMatch =
      rawTask.match(/[“"']([^"']+)[""']/) ||
      rawTask.match(/[《<]([^》>]+)[》>]/) ||
      rawTask.match(/(?:titled|标题是|标题为|叫做|名为)[\s:《"']*([^《"'\n]+?)(?:[》"']|$)/i);
    const title = titleMatch?.[1]?.trim() || 'Untitled';

    // If the user provided explicit data for Excel, parse a simple row format.
    if (type === 'excel') {
      const rows = parseInlineRows(rawTask);
      if (rows.length > 0) {
        return {
          type,
          title,
          description: 'Fast-path generated spreadsheet',
          content: { sheets: [{ name: 'Sheet1', rows }] },
          __fastPath: true,
        };
      }
    }

    return {
      type,
      title,
      description: 'Fast-path generated document',
      content:
        type === 'word'
          ? { sections: [{ heading: title, paragraphs: ['Generated by Office Agent.'] }] }
          : type === 'ppt'
            ? { slides: [{ title, bullets: ['Generated by Office Agent.'] }] }
            : { sheets: [{ name: 'Sheet1', headers: ['A', 'B'], rows: [] }] },
      __fastPath: true,
    };
  }

  function parseInlineRows(task: string): unknown[][] {
    // Matches rows like:  苹果 10, 香蕉 20  or  苹果:10, 香蕉:20
    const rows: unknown[][] = [];
    const listMatch = task.match(/[:：]\s*([^。]+)/);
    if (listMatch) {
      const items = listMatch[1].split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        const parts = item.split(/[\s:：]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) rows.push(parts);
      }
    }
    return rows;
  }

  async function parseTask(rawTask: string): Promise<{ task: OfficeTask; tokensIn: number; tokensOut: number; costUsd: number }> {
    const result = await callWithMetrics({
      llmProvider,
      model,
      messages: [
        { role: 'system', content: OFFICE_PARSE_PROMPT },
        { role: 'user', content: rawTask },
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens,
    });

    const parsed = parseJsonObject<Partial<OfficeTask>>(result.content);
    const type = (parsed.ok && typeof parsed.value.type === 'string'
      ? parsed.value.type
      : 'unknown') as OfficeTask['type'];

    return {
      task: {
        type,
        title: (parsed.ok && typeof parsed.value.title === 'string' && parsed.value.title) || 'Untitled',
        description: parsed.ok ? parsed.value.description : undefined,
        content: parsed.ok ? parsed.value.content ?? {} : {},
      },
      tokensIn: result.metrics.tokensIn,
      tokensOut: result.metrics.tokensOut,
      costUsd: result.metrics.costUsd,
    };
  }
}

type OfficeFileCreator = (task: OfficeTask, outputDir: string) => OfficeResult | Promise<OfficeResult>;

const OFFICE_CREATORS: ReadonlyMap<string, OfficeFileCreator> = new Map<string, OfficeFileCreator>([
  ['word', createWordDocument],
  ['excel', createExcelWorkbook],
  ['ppt', createPresentation],
]);

function isWordContent(content: OfficeContent | unknown): content is WordContent {
  return content != null && typeof content === 'object' && Array.isArray((content as WordContent).sections);
}

function isExcelContent(content: OfficeContent | unknown): content is ExcelContent {
  return content != null && typeof content === 'object' && Array.isArray((content as ExcelContent).sheets);
}

function isPptContent(content: OfficeContent | unknown): content is PptContent {
  return content != null && typeof content === 'object' && Array.isArray((content as PptContent).slides);
}

async function generateOfficeFile(
  task: OfficeTask,
  outputDir: string,
  opts: { llmProvider: ILLMProvider; model: ModelSpec; maxTokens: number },
): Promise<OfficeResult> {
  fs.mkdirSync(outputDir, { recursive: true });

  const creator = OFFICE_CREATORS.get(task.type);
  if (!creator) {
    throw new Error(`Unsupported office type: ${task.type}`);
  }
  return creator(task, outputDir);
}

function createWordDocument(task: OfficeTask, outputDir: string): OfficeResult {
  const safeTitle = sanitizeFilename(task.title);
  const docxPath = path.join(outputDir, `${safeTitle}.docx`);
  const fallbackMdPath = path.join(outputDir, `${safeTitle}.md`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const docx = require('docx');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

    const sections: WordSection[] = isWordContent(task.content)
      ? task.content.sections
      : [{ heading: 'Content', paragraphs: [JSON.stringify(task.content, null, 2)] }];

    const children: unknown[] = [new Paragraph({ text: task.title, heading: HeadingLevel.TITLE })];
    if (task.description) {
      children.push(new Paragraph({ text: task.description }));
    }
    for (const section of sections) {
      if (section.heading) {
        children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));
      }
      for (const para of section.paragraphs ?? []) {
        children.push(new Paragraph({ children: [new TextRun(para)] }));
      }
    }

    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buffer = Packer.toBuffer(doc);
    fs.writeFileSync(docxPath, buffer);
    return { fileType: 'word', filePath: docxPath };
  } catch {
    // Fallback: write a markdown representation.
    const md = renderMarkdown(task);
    fs.writeFileSync(fallbackMdPath, md);
    return { fileType: 'word(markdown-fallback)', filePath: fallbackMdPath, fallback: true, note: 'docx library not installed; wrote markdown fallback.' };
  }
}

function createExcelWorkbook(task: OfficeTask, outputDir: string): OfficeResult {
  const safeTitle = sanitizeFilename(task.title);
  const xlsxPath = path.join(outputDir, `${safeTitle}.xlsx`);
  const fallbackCsvPath = path.join(outputDir, `${safeTitle}.csv`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const sheets: ExcelSheet[] = isExcelContent(task.content)
      ? task.content.sheets
      : [{ name: 'Sheet1', rows: [] }];

    for (const sheet of sheets) {
      const rows: unknown[][] = [];
      if (sheet.headers && sheet.headers.length > 0) rows.push(sheet.headers);
      for (const row of sheet.rows ?? []) rows.push(row);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
    }
    XLSX.writeFile(wb, xlsxPath);
    return { fileType: 'excel', filePath: xlsxPath };
  } catch {
    // Fallback: write CSV for the first sheet.
    const sheet = isExcelContent(task.content) ? task.content.sheets[0] : undefined;
    const rows: unknown[][] = [];
    if (sheet?.headers) rows.push(sheet.headers);
    for (const row of sheet?.rows ?? []) rows.push(row);
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    fs.writeFileSync(fallbackCsvPath, csv);
    return { fileType: 'excel(csv-fallback)', filePath: fallbackCsvPath, fallback: true, note: 'xlsx library not installed; wrote CSV fallback.' };
  }
}

async function createPresentation(task: OfficeTask, outputDir: string): Promise<OfficeResult> {
  const safeTitle = sanitizeFilename(task.title);
  const pptxPath = path.join(outputDir, `${safeTitle}.pptx`);
  const fallbackMdPath = path.join(outputDir, `${safeTitle}-slides.md`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PptxGenJS = require('pptxgenjs');
    const pres = new PptxGenJS();
    pres.title = task.title;
    pres.subject = task.description ?? '';

    const slides: PptSlide[] = isPptContent(task.content)
      ? task.content.slides
      : [];

    for (const slide of slides) {
      const s = pres.addSlide();
      s.addText(slide.title ?? '', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 24, bold: true });
      if (slide.subtitle) {
        s.addText(slide.subtitle, { x: 0.5, y: 1.5, w: 9, h: 0.5, fontSize: 14 });
      }
      if (slide.bullets && slide.bullets.length > 0) {
        s.addText(
          slide.bullets.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 0.5, y: 2, w: 9, h: 4, fontSize: 14 },
        );
      }
    }
    await pres.writeFile({ fileName: pptxPath });
    return { fileType: 'ppt', filePath: pptxPath };
  } catch {
    const md = renderMarkdown(task);
    fs.writeFileSync(fallbackMdPath, md);
    return { fileType: 'ppt(markdown-fallback)', filePath: fallbackMdPath, fallback: true, note: 'pptxgenjs library not installed; wrote markdown fallback.' };
  }
}

async function tryEditExistingFile(taskText: string, _outputDir: string): Promise<OfficeResult | null> {
  // Look for an existing office file path in the task text.
  const pathMatch =
    taskText.match(/["']([^"']+\.(?:xlsx|xls|docx|doc|pptx|ppt))["']/i) ||
    taskText.match(/([A-Za-z]:\\[^\s:"]+\.(?:xlsx|xls|docx|doc|pptx|ppt))/i) ||
    taskText.match(/(\/[^\s:"]+\.(?:xlsx|xls|docx|doc|pptx|ppt))/i);
  const filePath = pathMatch?.[1];
  if (!filePath || !fs.existsSync(filePath)) return null;

  const lowered = taskText.toLowerCase();
  const isEdit = /\b(edit|update|add|append|insert|modify|change)\b|编辑|更新|添加|追加|插入|修改|更改/.test(lowered);
  if (!isEdit) return null;

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filePath);
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const data: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Try to parse a new row from the task text after a colon or comma list.
      const newRow = parseInlineRowData(taskText);
      if (newRow.length > 0) {
        data.push(newRow);
        const newWs = XLSX.utils.aoa_to_sheet(data);
        wb.Sheets[sheetName] = newWs;
        XLSX.writeFile(wb, filePath);
        return { fileType: 'excel', filePath, note: `Appended row: ${newRow.join(', ')}` };
      }
      return { fileType: 'excel', filePath, note: 'Existing workbook loaded, no new row provided.' };
    } catch (err: unknown) {
      return { fileType: 'excel', filePath, fallback: true, note: `Edit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Word/PPT editing requires additional read libraries; return a clear note for now.
  return {
    fileType: ext.includes('doc') ? 'word' : 'ppt',
    filePath,
    fallback: true,
    note: 'Editing existing Word/PowerPoint files is not yet supported; please provide the full content to recreate the file.',
  };
}

function parseInlineRowData(taskText: string): unknown[] {
  const listMatch = taskText.match(/[:：]\s*([^。]+)/);
  if (!listMatch) return [];
  const items = listMatch[1].split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return [];
  // If the task mentions "add row" or "添加一行", use the comma list as cells.
  if (/\b(add row|append row|insert row|添加一行|追加一行)\b/i.test(taskText)) {
    return items.map((cell) => {
      const n = Number(cell);
      return Number.isNaN(n) ? cell : n;
    });
  }
  return [];
}

function renderMarkdown(task: OfficeTask): string {
  let md = `# ${task.title}\n\n`;
  if (task.description) md += `${task.description}\n\n`;
  md += '```json\n';
  md += JSON.stringify(task.content, null, 2);
  md += '\n```\n';
  return md;
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}
