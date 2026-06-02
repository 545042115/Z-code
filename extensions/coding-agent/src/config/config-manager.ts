import * as vscode from 'vscode';

export interface LLMConfigProfile {
  id: string;
  name: string;
  provider: 'sglang' | 'openai' | 'azure' | 'deepseek' | 'mimo';
  endpoint: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  organization?: string;
}

export class ConfigManager {
  private static readonly PROFILES_KEY = 'llmProfiles';
  private static readonly ACTIVE_PROFILE_KEY = 'activeProfile';
  private static context: vscode.ExtensionContext;

  static init(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  static getAllProfiles(): LLMConfigProfile[] {
    if (!this.context) return [];
    return this.context.globalState.get<LLMConfigProfile[]>(this.PROFILES_KEY) || [];
  }

  static getActiveProfile(): LLMConfigProfile | undefined {
    const profiles = this.getAllProfiles();
    const activeId = this.getActiveProfileId();
    if (activeId) {
      return profiles.find(p => p.id === activeId);
    }
    return profiles[0];
  }

  static getActiveProfileId(): string | undefined {
    if (!this.context) return undefined;
    return this.context.globalState.get<string>(this.ACTIVE_PROFILE_KEY);
  }

  static async saveProfile(profile: LLMConfigProfile): Promise<void> {
    const profiles = this.getAllProfiles();
    const existingIndex = profiles.findIndex(p => p.id === profile.id);
    if (existingIndex >= 0) {
      profiles[existingIndex] = profile;
    } else {
      profiles.push(profile);
    }
    await this.context.globalState.update(this.PROFILES_KEY, profiles);
  }

  static async deleteProfile(profileId: string): Promise<void> {
    const profiles = this.getAllProfiles();
    const filtered = profiles.filter(p => p.id !== profileId);
    await this.context.globalState.update(this.PROFILES_KEY, filtered);
    const activeId = this.getActiveProfileId();
    if (activeId === profileId) {
      await this.setActiveProfile(filtered[0]?.id);
    }
  }

  static async setActiveProfile(profileId: string | undefined): Promise<void> {
    await this.context.globalState.update(this.ACTIVE_PROFILE_KEY, profileId);
    if (profileId) {
      const profile = this.getAllProfiles().find(p => p.id === profileId);
      if (profile) {
        await this.applyProfileToConfig(profile);
      }
    }
  }

  private static async applyProfileToConfig(profile: LLMConfigProfile): Promise<void> {
    const config = vscode.workspace.getConfiguration('codingAgent');
    await config.update('llm.provider', profile.provider, vscode.ConfigurationTarget.Global);
    await config.update('llm.endpoint', profile.endpoint, vscode.ConfigurationTarget.Global);
    await config.update('llm.apiKey', '', vscode.ConfigurationTarget.Global);
    await config.update('llm.model', profile.model, vscode.ConfigurationTarget.Global);
    await config.update('llm.maxTokens', profile.maxTokens, vscode.ConfigurationTarget.Global);
    await config.update('llm.temperature', profile.temperature, vscode.ConfigurationTarget.Global);
    await config.update('llm.organization', '', vscode.ConfigurationTarget.Global);
  }

  static async initDefaultProfiles(): Promise<void> {
    const profiles = this.getAllProfiles();
    if (profiles.length === 0) {
      const defaultProfile: LLMConfigProfile = {
        id: 'sglang-local',
        name: 'SGLang 本地',
        provider: 'sglang',
        endpoint: 'http://localhost:30000',
        model: 'default',
        maxTokens: 4096,
        temperature: 0.1,
      };
      await this.context.globalState.update(this.PROFILES_KEY, [defaultProfile]);
      await this.setActiveProfile('sglang-local');
    }
  }

  static async showSetupWizard(): Promise<void> {
    const profiles = this.getAllProfiles();
    if (profiles.length > 0) return;

    const setupChoice = await vscode.window.showQuickPick(
      [
        {
          label: '$(server) 本地 SGLang',
          description: '使用本地部署的 SGLang 推理服务（推荐，免费、无需 API Key）',
          value: 'sglang' as const,
        },
        {
          label: '$(cloud) 云 API',
          description: '使用 OpenAI / Deepseek / 小米 MiMo 等云端 API',
          value: 'cloud' as const,
        },
        {
          label: '$(gear) 两者都要',
          description: '同时配置本地 SGLang 和云 API，一键切换',
          value: 'both' as const,
        },
      ],
      {
        placeHolder: '🚀 欢迎使用 Coding Agent！请选择 LLM 连接方式：',
        canPickMany: false,
      }
    );

    if (!setupChoice) return;

    const savedProfiles: LLMConfigProfile[] = [];
    let activeId: string | undefined;

    if (setupChoice.value === 'sglang' || setupChoice.value === 'both') {
      const sglangProfile: LLMConfigProfile = {
        id: 'sglang-local',
        name: 'SGLang 本地',
        provider: 'sglang',
        endpoint: 'http://localhost:30000',
        model: 'default',
        maxTokens: 4096,
        temperature: 0.1,
      };
      savedProfiles.push(sglangProfile);
      if (!activeId) activeId = sglangProfile.id;
    }

    if (setupChoice.value === 'cloud' || setupChoice.value === 'both') {
      const cloudProfile = await this.setupCloudProfile();
      if (cloudProfile) {
        savedProfiles.push(cloudProfile);
        if (setupChoice.value === 'both') {
          const defaultChoice = await vscode.window.showQuickPick(
            [
              { label: 'SGLang 本地', description: '默认使用本地推理', value: 'sglang-local' },
              { label: cloudProfile.name, description: '默认使用云端 API', value: cloudProfile.id },
            ],
            { placeHolder: '默认使用哪个配置？可随时切换' }
          );
          if (defaultChoice) {
            activeId = defaultChoice.value;
          }
        } else {
          activeId = cloudProfile.id;
        }
      }
    }

    if (savedProfiles.length === 0) return;

    await this.context.globalState.update(this.PROFILES_KEY, savedProfiles);
    if (activeId) {
      await this.setActiveProfile(activeId);
    }

    const profileCount = savedProfiles.length;
    const msg = await vscode.window.showInformationMessage(
      `✅ 已配置 ${profileCount} 个 LLM 配置！按 Ctrl+Shift+L 打开 Chat 开始使用。`,
      '打开 Chat',
      '切换配置'
    );

    if (msg === '打开 Chat') {
      vscode.commands.executeCommand('codingAgent.openChat');
    } else if (msg === '切换配置') {
      await this.showProfilePicker();
    }
  }

  private static async setupCloudProfile(): Promise<LLMConfigProfile | undefined> {
    const providerChoice = await vscode.window.showQuickPick(
      [
        { label: 'OpenAI', description: 'GPT-4 / GPT-3.5', value: 'openai' as const },
        { label: 'Deepseek', description: '高性价比国产大模型', value: 'deepseek' as const },
        { label: '小米 MiMo', description: '小米大模型平台', value: 'mimo' as const },
        { label: 'Azure OpenAI', description: '企业级 OpenAI 服务', value: 'azure' as const },
      ],
      { placeHolder: '选择云 API 提供商', canPickMany: false }
    );

    if (!providerChoice) return undefined;

    const apiKey = await vscode.window.showInputBox({
      prompt: `输入 ${providerChoice.label} API Key（必填）`,
      password: true,
      placeHolder: 'sk-... 或您的 API Key',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value || value.trim().length === 0) {
          return 'API Key 不能为空';
        }
        return null;
      },
    });

    if (!apiKey) return undefined;

    const advancedOptions = await vscode.window.showQuickPick(
      [
        { label: '否，使用默认配置', value: false as const },
        { label: '是，自定义端点和模型名', value: true as const },
      ],
      { placeHolder: '是否自定义 API 端点和模型名？' }
    );

    let endpoint = this.getDefaultEndpoint(providerChoice.value);
    let model = this.getDefaultModel(providerChoice.value);

    if (advancedOptions?.value) {
      const customEndpoint = await vscode.window.showInputBox({
        prompt: 'API 端点',
        value: endpoint,
        placeHolder: 'https://api.example.com/v1',
      });
      if (customEndpoint) endpoint = customEndpoint;

      const customModel = await vscode.window.showInputBox({
        prompt: '模型名称',
        value: model,
        placeHolder: 'gpt-4, deepseek-chat, ...',
      });
      if (customModel) model = customModel;
    }

    return {
      id: `${providerChoice.value}-${Date.now()}`,
      name: `${providerChoice.label}`,
      provider: providerChoice.value,
      endpoint,
      apiKey,
      model,
      maxTokens: 4096,
      temperature: 0.1,
    };
  }

  static async showProfilePicker(): Promise<LLMConfigProfile | undefined> {
    const profiles = this.getAllProfiles();
    const activeId = this.getActiveProfileId();
    
    const items = profiles.map(profile => ({
      label: profile.name,
      description: `${profile.provider} - ${profile.model}`,
      detail: profile.endpoint,
      profile,
      picked: profile.id === activeId,
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择 LLM 配置',
      canPickMany: false,
    });
    
    if (selected) {
      await this.setActiveProfile(selected.profile.id);
      vscode.window.showInformationMessage(`已切换到: ${selected.profile.name}`);
      return selected.profile;
    }
    
    return undefined;
  }

  static async showProfileEditor(profile?: LLMConfigProfile): Promise<void> {
    const isNew = !profile;
    
    const name = await vscode.window.showInputBox({
      prompt: '配置名称',
      value: profile?.name || '',
      placeHolder: '例如: SGLang 本地, Deepseek V4',
    });
    
    if (!name) return;
    
    const provider = await vscode.window.showQuickPick(
      [
        { label: 'SGLang', value: 'sglang' as const },
        { label: 'OpenAI', value: 'openai' as const },
        { label: 'Azure OpenAI', value: 'azure' as const },
        { label: 'Deepseek', value: 'deepseek' as const },
        { label: '小米 MiMo', value: 'mimo' as const },
      ],
      { placeHolder: '选择 LLM 提供商' }
    );
    
    if (!provider) return;
    
    const endpoint = await vscode.window.showInputBox({
      prompt: 'API 服务地址（必填）- 如 https://api.deepseek.com/v1',
      value: profile?.endpoint || this.getDefaultEndpoint(provider.value),
      placeHolder: 'https://api.deepseek.com/v1 或 http://localhost:30000',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value || value.trim().length === 0) {
          return 'API 服务地址不能为空';
        }
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return '请输入有效的 URL，以 http:// 或 https:// 开头';
        }
        return null;
      },
    });
    
    if (!endpoint) return;
    
    const apiKey = await vscode.window.showInputBox({
      prompt: `API Key${provider.value === 'sglang' ? '（本地部署可不填）' : '（必填）'} - 密钥，不是服务地址`,
      value: profile?.apiKey || '',
      password: true,
      placeHolder: provider.value === 'sglang' ? '本地部署可不填' : 'sk-...',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (provider.value !== 'sglang' && (!value || value.trim().length === 0)) {
          return '云 API 需要提供 API Key';
        }
        if (value && value.startsWith('http')) {
          return '这看起来像 URL 而非 API Key，请检查是否是服务地址';
        }
        return null;
      },
    });
    
    const model = await vscode.window.showInputBox({
      prompt: '模型名称',
      value: profile?.model || this.getDefaultModel(provider.value),
      placeHolder: 'gpt-4, deepseek-chat, default',
    });
    
    if (!model) return;
    
    const newProfile: LLMConfigProfile = {
      id: profile?.id || `profile-${Date.now()}`,
      name,
      provider: provider.value,
      endpoint,
      apiKey: apiKey || undefined,
      model,
      maxTokens: profile?.maxTokens || 4096,
      temperature: profile?.temperature || 0.1,
    };
    
    await this.saveProfile(newProfile);
    
    if (isNew) {
      const activate = await vscode.window.showQuickPick(
        ['是', '否'],
        { placeHolder: '是否立即激活此配置？' }
      );
      if (activate === '是') {
        await this.setActiveProfile(newProfile.id);
      }
    }
    
    vscode.window.showInformationMessage(`已保存配置: ${name}`);
  }

  private static getDefaultEndpoint(provider: string): string {
    switch (provider) {
      case 'sglang': return 'http://localhost:30000';
      case 'openai': return 'https://api.openai.com';
      case 'azure': return 'https://your-resource.openai.azure.com/openai/deployments/your-deployment';
      case 'deepseek': return 'https://api.deepseek.com';
      case 'mimo': return 'https://api.xiaomimimo.com';
      default: return '';
    }
  }

  private static getDefaultModel(provider: string): string {
    switch (provider) {
      case 'sglang': return 'default';
      case 'openai': return 'gpt-4';
      case 'azure': return 'gpt-4';
      case 'deepseek': return 'deepseek-v4-flash';
      case 'mimo': return 'mimo-v2-flash';
      default: return '';
    }
  }
}