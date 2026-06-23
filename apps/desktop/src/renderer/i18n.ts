// @z-assistant/app-desktop — i18n (中文 / English)

declare const zApi: import('../preload').ZDesktopAPI;

export type Language = 'zh-CN' | 'en';

type TranslationMap = Record<string, { 'zh-CN': string; en: string }>;

const TRANSLATIONS: TranslationMap = {
  // Nav
  'nav.main':     { 'zh-CN': '主页',       en: 'Main' },
  'nav.chat':     { 'zh-CN': '对话',       en: 'Chat' },
  'nav.trace':    { 'zh-CN': '追踪',       en: 'Trace' },
  'nav.settings': { 'zh-CN': '设置',       en: 'Settings' },

  // Main view
  'main.title':       { 'zh-CN': 'Z Assistant 桌面版', en: 'Z Assistant Desktop' },
  'main.description': { 'zh-CN': '使用上方导航栏或系统托盘菜单打开对话、追踪和设置面板。', en: 'Use the navigation above or the tray menu to open Chat, Trace, and Settings panels.' },

  // Chat
  'chat.placeholder':   { 'zh-CN': '输入你的请求…', en: 'Enter your request…' },
  'chat.send':          { 'zh-CN': '发送',         en: 'Send' },
  'chat.you':           { 'zh-CN': '你',           en: 'You' },
  'chat.assistant':     { 'zh-CN': '助手',         en: 'Assistant' },
  'chat.submitted':     { 'zh-CN': '任务已提交。运行 ID:', en: 'Task submitted. Run ID:' },
  'chat.error':         { 'zh-CN': '错误',         en: 'Error' },
  'chat.sessions':      { 'zh-CN': '会话',         en: 'Sessions' },
  'chat.new':           { 'zh-CN': '新对话',       en: 'New Chat' },
  'chat.delete':        { 'zh-CN': '删除会话',     en: 'Delete Session' },
  'chat.export':        { 'zh-CN': '导出',         en: 'Export' },
  'chat.confirmDelete': { 'zh-CN': '确定要删除此对话吗？', en: 'Delete this conversation?' },
  'chat.yes':           { 'zh-CN': '确定',         en: 'Yes' },
  'chat.no':            { 'zh-CN': '取消',         en: 'No' },
  'chat.mode':          { 'zh-CN': '规划模式',     en: 'Planning Mode' },
  'chat.mode_hint':     { 'zh-CN': '输入 /simple /hierarchical /plan /auto 切换，/mode 查看', en: 'Type /simple /hierarchical /plan /auto to switch, /mode to show' },
  'chat.mode_switched': { 'zh-CN': '已切换规划模式为', en: 'Planning mode switched to' },
  'chat.mode_current':  { 'zh-CN': '当前规划模式:',  en: 'Current planning mode:' },

  // Trace
  'trace.runs':         { 'zh-CN': '运行记录',     en: 'Runs' },
  'trace.refresh':      { 'zh-CN': '刷新',         en: 'Refresh' },
  'trace.loading':      { 'zh-CN': '加载中…',      en: 'Loading…' },
  'trace.not_found':    { 'zh-CN': '未找到记录。',  en: 'Record not found.' },
  'trace.failed_load':  { 'zh-CN': '加载失败',     en: 'Failed to load' },
  'trace.untitled':     { 'zh-CN': '无标题',       en: 'untitled' },
  'trace.spans':        { 'zh-CN': 'Span',         en: 'Spans' },
  'trace.no_sessions':  { 'zh-CN': '暂无对话记录。开始一个新对话吧！', en: 'No sessions yet. Start a new chat!' },
  'trace.messages':     { 'zh-CN': '条消息',       en: 'messages' },
  'trace.created':      { 'zh-CN': '创建于',       en: 'Created' },
  'trace.updated':      { 'zh-CN': '更新于',       en: 'Updated' },
  'trace.conversation': { 'zh-CN': '对话内容',     en: 'Conversation' },
  'trace.run_details':  { 'zh-CN': '运行详情',     en: 'Run Details' },
  'trace.total_runs':   { 'zh-CN': '运行次数',     en: 'Total Runs' },
  'trace.tokens_in':    { 'zh-CN': '输入 Token',   en: 'Tokens In' },
  'trace.tokens_out':   { 'zh-CN': '输出 Token',   en: 'Tokens Out' },
  'trace.cost':         { 'zh-CN': '费用',         en: 'Cost' },
  'trace.load_spans':   { 'zh-CN': '查看 Span',    en: 'View Spans' },
  'trace.no_spans':     { 'zh-CN': '无 Span 数据', en: 'No span data' },
  'trace.no_runs':      { 'zh-CN': '暂无运行记录。', en: 'No run records yet.' },
  'trace.export':       { 'zh-CN': '导出追踪',     en: 'Export Trace' },
  'trace.model':        { 'zh-CN': '模型',         en: 'Model' },
  'trace.status':       { 'zh-CN': '状态',         en: 'Status' },
  'trace.duration':     { 'zh-CN': '耗时',         en: 'Duration' },
  'trace.tools':        { 'zh-CN': '工具调用',     en: 'Tool Calls' },
  'trace.events':       { 'zh-CN': '事件',         en: 'Events' },
  'trace.attributes':   { 'zh-CN': '属性',         en: 'Attributes' },
  'trace.error':        { 'zh-CN': '错误',         en: 'Error' },
  'trace.input':        { 'zh-CN': '输入',         en: 'Input' },
  'trace.output':       { 'zh-CN': '输出',         en: 'Output' },
  'trace.llm_calls':    { 'zh-CN': 'LLM 调用',     en: 'LLM Calls' },
  'trace.span_count':   { 'zh-CN': 'Span 数',      en: 'Span Count' },

  // Memory
  'settings.model':       { 'zh-CN': '模型',           en: 'Model' },
  'settings.provider':    { 'zh-CN': '提供商',         en: 'Provider' },
  'settings.model_name':  { 'zh-CN': '模型名称',       en: 'Model Name' },
  'settings.api_key':     { 'zh-CN': 'API 密钥',       en: 'API Key' },
  'settings.api_endpoint':{ 'zh-CN': 'API 端点',       en: 'API Endpoint' },
  'settings.memory':      { 'zh-CN': '记忆',           en: 'Memory' },
  'settings.memory_label':{ 'zh-CN': '启用长期记忆',   en: 'Enable Long-Term Memory' },
  'settings.storage':     { 'zh-CN': '存储',           en: 'Storage' },
  'settings.data_dir':    { 'zh-CN': '数据目录',       en: 'Data Directory' },
  'settings.language':    { 'zh-CN': '语言',           en: 'Language' },
  'settings.save':        { 'zh-CN': '保存',           en: 'Save' },
  'settings.saved':       { 'zh-CN': '设置已保存。',   en: 'Settings saved.' },
  'settings.model_placeholder': { 'zh-CN': '例如 deepseek-chat', en: 'e.g. claude-3-5-sonnet' },
  'settings.project':     { 'zh-CN': '项目',           en: 'Project' },
  'settings.project_dir': { 'zh-CN': '项目目录',       en: 'Project Directory' },
  'settings.auto_reply':  { 'zh-CN': '自动回复',       en: 'Auto Reply' },
  'settings.wechat_title': { 'zh-CN': '微信（Hook DLL 注入）', en: 'WeChat (Hook DLL Injection)' },
  'settings.wechat_hook_warning': { 'zh-CN': '通过 DLL 注入捕获微信消息，可接收好友私聊消息，但存在封号风险，请谨慎使用', en: 'Uses DLL injection to capture all WeChat messages. Can receive private messages but has ban risk.' },
  'settings.wechat_hook_connect': { 'zh-CN': '连接微信', en: 'Connect WeChat' },
  'settings.wechat_hook_disconnect': { 'zh-CN': '断开', en: 'Disconnect' },
  'settings.wechat_hook_disconnected': { 'zh-CN': '未连接', en: 'Disconnected' },
  'settings.wechat_hook_connecting': { 'zh-CN': '连接中...', en: 'Connecting...' },
  'settings.qq_title': { 'zh-CN': 'QQ（NapCat + OneBot 协议）', en: 'QQ (NapCat + OneBot Protocol)' },
  'settings.qq_desc': { 'zh-CN': '通过 NapCat 连接 QQ，NapCat 启动后会暴露 WebSocket 地址（默认 ws://localhost:3001）', en: 'Connect via NapCat. NapCat exposes a WebSocket address (default ws://localhost:3001).' },
  'settings.qq_connect': { 'zh-CN': '连接 QQ', en: 'Connect QQ' },
  'settings.qq_disconnect': { 'zh-CN': '断开', en: 'Disconnect' },
  'settings.qq_disconnected': { 'zh-CN': '未连接', en: 'Disconnected' },
  'settings.profile_title': { 'zh-CN': '聊天风格模仿', en: 'Chat Style Mimic' },
  'settings.profile_enable': { 'zh-CN': '启用风格模仿（根据历史消息模仿你的聊天语气）', en: 'Enable style mimic (imitate your tone from chat history)' },
  'settings.profile_msg_count': { 'zh-CN': '已收集消息数', en: 'Messages collected' },
  'settings.profile_desc': { 'zh-CN': '风格描述', en: 'Style description' },
  'settings.profile_none': { 'zh-CN': '暂无数据，连接微信后会自动收集', en: 'No data yet. Will collect automatically when WeChat is connected.' },
  'settings.profile_rebuild': { 'zh-CN': '重新生成', en: 'Rebuild' },
  'settings.profile_clear': { 'zh-CN': '清空数据', en: 'Clear' },
  'settings.profile_clear_confirm': { 'zh-CN': '确定清空所有已收集的聊天风格数据吗？', en: 'Clear all collected style data?' },
  'settings.mcp_title': { 'zh-CN': 'MCP 外部工具', en: 'MCP External Tools' },
  'settings.mcp_desc': { 'zh-CN': '配置外部 MCP 服务所需的密钥；留空则使用同名环境变量。', en: 'Configure keys for external MCP servers; leave empty to use environment variables of the same name.' },
  'settings.mcd_token': { 'zh-CN': '麦当劳 MCP Token', en: "McDonald's MCP Token" },
  'settings.mcd_token_placeholder': { 'zh-CN': '输入你的麦当劳 MCP Token', en: "Enter your McDonald's MCP token" },
  'settings.mcd_token_hint': { 'zh-CN': '保存后会注入为 MCD_MCP_TOKEN 环境变量，供 mcpServers headers 中的 ${env:MCD_MCP_TOKEN} 使用。', en: 'Saved value is injected as MCD_MCP_TOKEN env var for ${env:MCD_MCP_TOKEN} placeholders in mcpServers headers.' },
  'settings.amap_key': { 'zh-CN': '高德地图 API Key', en: 'AMap API Key' },
  'settings.amap_key_placeholder': { 'zh-CN': '输入你的高德 Web 服务 Key', en: 'Enter your AMap Web Service API key' },
  'settings.amap_key_hint': { 'zh-CN': '保存后会注入为 AMAP_MAPS_API_KEY 环境变量，并自动连接高德 MCP Server。', en: 'Saved value is injected as AMAP_MAPS_API_KEY env var and automatically connects the AMap MCP server.' },
  'settings.skill_review_title': { 'zh-CN': 'Skill 审核队列', en: 'Skill Review Queue' },
  'settings.skill_review_desc': { 'zh-CN': '审查从成功但曲折的对话中自动提取的 Skill 候选。', en: 'Review skill candidates auto-extracted from winding-but-successful conversations.' },
  'settings.discover_skills': { 'zh-CN': '从对话总结 Skill', en: 'Discover from History' },
  'settings.refresh_skills': { 'zh-CN': '刷新', en: 'Refresh' },
  'settings.loading_skills': { 'zh-CN': '加载中…', en: 'Loading…' },
  'settings.no_skill_candidates': { 'zh-CN': '暂无待审核的 Skill 候选。', en: 'No pending skill candidates.' },
  'settings.skill_candidates_count': { 'zh-CN': '个候选', en: 'candidates' },
  'settings.approve_skill': { 'zh-CN': '批准', en: 'Approve' },
  'settings.reject_skill': { 'zh-CN': '拒绝', en: 'Reject' },
  'settings.view_skill_body': { 'zh-CN': '查看内容', en: 'View Body' },
  'settings.discovering_skills': { 'zh-CN': '正在总结 Skill…', en: 'Discovering skills…' },
  'settings.discovered': { 'zh-CN': '已总结', en: 'Discovered' },

  // Tool Policy / BudgetGuard / Always Rules (P1)
  'settings.tool_policy_title': { 'zh-CN': '工具策略', en: 'Tool Policy' },
  'settings.tool_policy_desc': { 'zh-CN': '配置允许或禁止 Agent 调用的工具名称（glob）。', en: 'Configure tool names the agent is allowed or denied to invoke (glob).' },
  'settings.tool_policy_allow': { 'zh-CN': '允许列表（留空表示允许所有）', en: 'Allow list (empty means allow all)' },
  'settings.tool_policy_deny': { 'zh-CN': '禁止列表', en: 'Deny list' },
  'settings.tool_policy_hint': { 'zh-CN': '多个工具名用逗号或换行分隔；deny 优先于 allow。', en: 'Separate tool names with commas or newlines; deny wins over allow.' },
  'settings.budget_title': { 'zh-CN': '预算上限', en: 'Budget Guard' },
  'settings.budget_desc': { 'zh-CN': '设置单次运行与每日的成本/Token 上限，超出将终止运行。', en: 'Set per-run and daily token/cost caps; exceeding them terminates the run.' },
  'settings.budget_tokens': { 'zh-CN': '单次运行 Token 上限', en: 'Per-run token cap' },
  'settings.budget_usd': { 'zh-CN': '单次运行 USD 上限', en: 'Per-run USD cap' },
  'settings.budget_day_usd': { 'zh-CN': '每日 USD 上限', en: 'Daily USD cap' },
  'settings.always_rules_title': { 'zh-CN': 'Always-Rules 管理', en: 'Always-Rules' },
  'settings.always_rules_desc': { 'zh-CN': '查看并删除通过"始终允许/拒绝"保存的确认规则。', en: 'View and delete confirmation rules saved via Always Allow/Deny.' },
  'settings.always_rules_all_args': { 'zh-CN': '匹配该工具的所有调用', en: 'Matches all invocations of this tool' },
  'settings.always_rules_remove': { 'zh-CN': '删除', en: 'Remove' },
  'settings.no_always_rules': { 'zh-CN': '暂无 Always-Rules。', en: 'No Always-Rules yet.' },

  // Trace audit (P1-4)
  'trace.load_audit': { 'zh-CN': '审计日志', en: 'Audit Log' },
  'trace.no_audit': { 'zh-CN': '暂无审计记录。', en: 'No audit records.' },
  'trace.audit_entries': { 'zh-CN': '条审计记录', en: 'audit records' },

  // Providers
  'provider.sglang':    { 'zh-CN': 'SGLang',       en: 'SGLang' },
  'provider.openai':    { 'zh-CN': 'OpenAI',       en: 'OpenAI' },
  'provider.anthropic': { 'zh-CN': 'Anthropic',    en: 'Anthropic' },
  'provider.ollama':    { 'zh-CN': 'Ollama',       en: 'Ollama' },
  'provider.deepseek':  { 'zh-CN': 'DeepSeek',     en: 'DeepSeek' },
  'provider.gemini':    { 'zh-CN': 'Google Gemini', en: 'Google Gemini' },
  'provider.custom':    { 'zh-CN': '自定义 (兼容 OpenAI)', en: 'Custom (OpenAI-compatible)' },

  // Memory view
  'memory.title':       { 'zh-CN': '记忆',         en: 'Memory' },
  'memory.refresh':     { 'zh-CN': '刷新',         en: 'Refresh' },
  'memory.no_data':     { 'zh-CN': '暂无记忆数据。', en: 'No memory data yet.' },
  'memory.loading':     { 'zh-CN': '加载中…',      en: 'Loading…' },
  'memory.failed_load': { 'zh-CN': '加载失败',     en: 'Failed to load' },
  'memory.kind':        { 'zh-CN': '类型',         en: 'Kind' },
  'memory.content':     { 'zh-CN': '内容',         en: 'Content' },
  'memory.time':        { 'zh-CN': '时间',         en: 'Time' },
  'memory.all':         { 'zh-CN': '全部',         en: 'All' },
  'memory.long_term':   { 'zh-CN': '长期记忆',     en: 'Long-term' },
  'memory.episodic':    { 'zh-CN': '情景记忆',     en: 'Episodic' },
  'memory.preference':  { 'zh-CN': '偏好记忆',     en: 'Preferences' },
  'memory.semantic':    { 'zh-CN': '语义记忆',     en: 'Semantic' },
  'memory.procedural':  { 'zh-CN': '程序记忆',     en: 'Procedural' },
  'memory.short_term':  { 'zh-CN': '短期记忆',     en: 'Short-term' },
  'memory.search':      { 'zh-CN': '搜索记忆',     en: 'Search Memory' },
  'memory.search_placeholder': { 'zh-CN': '输入关键词搜索记忆…', en: 'Search memories…' },
  'memory.delete':      { 'zh-CN': '删除',         en: 'Delete' },
  'memory.purge':       { 'zh-CN': '清空所有',     en: 'Purge All' },
  'memory.purge_confirm': { 'zh-CN': '确定要清空所有记忆吗？此操作不可恢复。', en: 'Purge all memories? This cannot be undone.' },
  'memory.delete_confirm': { 'zh-CN': '确定要删除此记忆吗？', en: 'Delete this memory?' },
  'memory.recall':      { 'zh-CN': '召回',         en: 'Recall' },
  'memory.recall_hint': { 'zh-CN': '在对话中快速插入记忆', en: 'Quick-insert memory into chat' },
  'memory.recall_result': { 'zh-CN': '相关记忆',   en: 'Related Memories' },
  'memory.recall_empty': { 'zh-CN': '未找到相关记忆', en: 'No related memories found' },
  'memory.export':      { 'zh-CN': '导出全部',     en: 'Export All' },
  'memory.stats':       { 'zh-CN': '统计',         en: 'Stats' },
  'memory.total':       { 'zh-CN': '总计',         en: 'Total' },
  'memory.count':       { 'zh-CN': '条',           en: ' items' },
  'memory.manage':      { 'zh-CN': '记忆管理',     en: 'Memory Management' },
  'memory.manage_desc': { 'zh-CN': '查看、搜索、导出或清空记忆数据', en: 'View, search, export or clear memory data' },
  'memory.go_to':       { 'zh-CN': '前往记忆面板', en: 'Go to Memory Panel' },

  // Trace
  'trace.auto_load':    { 'zh-CN': '自动加载 Span', en: 'Auto-load Spans' },
  'trace.filter':       { 'zh-CN': '过滤',         en: 'Filter' },
  'trace.all':          { 'zh-CN': '全部',         en: 'All' },
  'trace.search_spans': { 'zh-CN': '搜索 Span…',   en: 'Search spans…' },
  'trace.total':        { 'zh-CN': '总计',         en: 'Total' },

  // File System
  'file.save':           { 'zh-CN': '保存文件',     en: 'Save File' },
  'file.saved':          { 'zh-CN': '文件已保存',   en: 'File saved' },
  'file.save_failed':    { 'zh-CN': '保存失败',     en: 'Save failed' },
  'file.select_dir':     { 'zh-CN': '选择保存目录', en: 'Select directory' },
};

let currentLang: Language = 'en';

export function setLanguage(lang: Language): void {
  currentLang = lang;
  document.documentElement.lang = lang === 'zh-CN' ? 'zh-CN' : 'en';
  // Persist via zApi settings
  zApi.getSettings().then((s) => {
    zApi.setSettings({ language: lang } as any);
  }).catch(() => {});
}

export function getLanguage(): Language {
  return currentLang;
}

export async function loadLanguage(): Promise<Language> {
  try {
    const s = await zApi.getSettings() as any;
    if (s.language === 'zh-CN' || s.language === 'en') {
      currentLang = s.language;
    }
  } catch { /* ignore */ }
  document.documentElement.lang = currentLang === 'zh-CN' ? 'zh-CN' : 'en';
  return currentLang;
}

export function t(key: string): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[currentLang];
}
