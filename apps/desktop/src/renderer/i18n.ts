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

  // Settings
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

  // Providers
  'provider.sglang':    { 'zh-CN': 'SGLang',       en: 'SGLang' },
  'provider.openai':    { 'zh-CN': 'OpenAI',       en: 'OpenAI' },
  'provider.anthropic': { 'zh-CN': 'Anthropic',    en: 'Anthropic' },
  'provider.ollama':    { 'zh-CN': 'Ollama',       en: 'Ollama' },
  'provider.deepseek':  { 'zh-CN': 'DeepSeek',     en: 'DeepSeek' },
  'provider.gemini':    { 'zh-CN': 'Google Gemini', en: 'Google Gemini' },
  'provider.custom':    { 'zh-CN': '自定义 (兼容 OpenAI)', en: 'Custom (OpenAI-compatible)' },
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
