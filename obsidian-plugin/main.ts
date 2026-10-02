import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type OutputType = 'slides' | 'poster';
type StylePreset = 'academic' | 'doraemon' | 'custom';
type ContentType = 'paper' | 'general';
type SlidesLength = 'short' | 'medium' | 'long';
type PosterDensity = 'sparse' | 'medium' | 'dense';
type ApiProvider = 'repo_defaults' | 'z_ai' | 'lm_studio' | 'ollama' | 'anythingllm';
type ZAiEntrypoint = 'international_coding_plan';
type ZAiModelPreset = 'glm-5.1' | 'custom';

interface Paper2SlidesSettings {
	pythonPath: string;
	p2sPath: string;
	outputType: OutputType;
	style: StylePreset;
	customStyle: string;
	slidesLength: SlidesLength;
	posterDensity: PosterDensity;
	fastMode: boolean;
	parallelWorkers: number;
	importRoot: string;
	saveRunLog: boolean;
	apiProvider: ApiProvider;
	zAiEntrypoint: ZAiEntrypoint;
	zAiApiKey: string;
	zAiModelPreset: ZAiModelPreset;
	zAiCustomModel: string;
	localProviderBaseUrl: string;
	localProviderApiKey: string;
	localProviderModel: string;
	anythingllmBaseUrl: string;
}

interface RunContext {
	file: TFile;
	contentType: ContentType;
	process: ChildProcess;
	startedAt: number;
	targetDir: string;
	logLines: string[];
}

interface ValidationResult {
	ok: boolean;
	lines: string[];
}

interface ProviderTestResult {
	ok: boolean;
	lines: string[];
}

interface FetchJsonResult {
	ok: boolean;
	status: number;
	body: any;
	error?: string;
}

const DEFAULT_SETTINGS: Paper2SlidesSettings = {
	pythonPath: 'python3',
	p2sPath: '',
	outputType: 'slides',
	style: 'doraemon',
	customStyle: '',
	slidesLength: 'short',
	posterDensity: 'medium',
	fastMode: false,
	parallelWorkers: 1,
	importRoot: 'Paper2Slides',
	saveRunLog: true,
	apiProvider: 'repo_defaults',
	zAiEntrypoint: 'international_coding_plan',
	zAiApiKey: '',
	zAiModelPreset: 'glm-5.1',
	zAiCustomModel: '',
	localProviderBaseUrl: 'http://127.0.0.1:1234/v1',
	localProviderApiKey: '',
	localProviderModel: '',
	anythingllmBaseUrl: 'http://localhost:3001/api/v1',
};

const TIMESTAMP_DIR_PATTERN = /^\d{8}_\d{6}$/;
const Z_AI_CODING_PLAN_URL = 'https://api.z.ai/api/coding/paas/v4/';
const LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const PROVIDER_REQUEST_TIMEOUT_MS = 10000;

export default class Paper2SlidesPlugin extends Plugin {
	settings: Paper2SlidesSettings;
	activeRun: RunContext | null = null;
	availableProviderModels: string[] = [];
	providerStatus: ProviderTestResult | null = null;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('presentation', 'Generate with Paper2Slides', async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || !this.isSupportedSource(file)) {
				new Notice('Open a PDF or Markdown note first.');
				return;
			}
			await this.generateSlides(file);
		});

		this.addSettingTab(new Paper2SlidesSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && this.isSupportedSource(file)) {
					menu.addItem((item) => {
						item
							.setTitle('Generate Slides/Poster (Paper2Slides)')
							.setIcon('presentation')
							.onClick(async () => {
								await this.generateSlides(file);
							});
					});

					menu.addItem((item) => {
						item
							.setTitle('Re-import latest Paper2Slides outputs')
							.setIcon('sync')
							.onClick(async () => {
								await this.reimportLatestOutputs(file);
							});
					});
				}
			}),
		);

		this.addCommand({
			id: 'generate-slides-current-file',
			name: 'Generate Slides/Poster from current file',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file && this.isSupportedSource(file)) {
					if (!checking) {
						void this.generateSlides(file);
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'reimport-latest-outputs-current-file',
			name: 'Re-import latest Paper2Slides outputs for current file',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file && this.isSupportedSource(file)) {
					if (!checking) {
						void this.reimportLatestOutputs(file);
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'check-paper2slides-setup',
			name: 'Check Paper2Slides setup',
			callback: async () => {
				await this.runSetupCheck(true);
			},
		});

		this.addCommand({
			id: 'test-selected-provider',
			name: 'Test selected provider',
			callback: async () => {
				await this.testSelectedProvider(true);
			},
		});

		this.addCommand({
			id: 'refresh-provider-models',
			name: 'Refresh provider model list',
			callback: async () => {
				await this.refreshProviderModels(true);
			},
		});

		this.addCommand({
			id: 'stop-paper2slides-run',
			name: 'Stop current Paper2Slides run',
			checkCallback: (checking: boolean) => {
				if (this.activeRun) {
					if (!checking) {
						void this.stopCurrentRun();
					}
					return true;
				}
				return false;
			},
		});
	}

	isSupportedSource(file: TFile): boolean {
		return file.extension === 'pdf' || file.extension === 'md';
	}

	private getContentType(file: TFile): ContentType {
		return file.extension === 'md' ? 'general' : 'paper';
	}

	private getStyleArgument(): string {
		if (this.settings.style === 'custom') {
			const prompt = this.settings.customStyle.trim();
			return prompt.length > 0 ? prompt : 'minimal clean academic presentation';
		}

		return this.settings.style;
	}

	private getVaultImportRoot(): string {
		return this.settings.importRoot.trim().replace(/^\/+|\/+$/g, '') || 'Paper2Slides';
	}

	private getTargetDir(sourceFile: TFile): string {
		return path.posix.join(this.getVaultImportRoot(), sourceFile.basename);
	}

	private appendLogLine(run: RunContext, line: string): void {
		if (line.trim().length > 0) {
			run.logLines.push(line);
		}
	}

	private getResolvedModel(): string {
		if (this.settings.apiProvider === 'z_ai') {
			if (this.settings.zAiModelPreset === 'custom') {
				return this.settings.zAiCustomModel.trim() || 'glm-5.1';
			}
			return this.settings.zAiModelPreset;
		}

		if (this.settings.apiProvider === 'lm_studio' || this.settings.apiProvider === 'ollama' || this.settings.apiProvider === 'anythingllm') {
			return this.settings.localProviderModel.trim() || this.getDefaultModelForProvider(this.settings.apiProvider);
		}

		return '';
	}

	getDefaultModelForProvider(provider = this.settings.apiProvider): string {
		switch (provider) {
			case 'z_ai':
				return 'glm-5.1';
			case 'ollama':
				return 'llama3.1:8b';
			case 'lm_studio':
				return 'your-loaded-model';
			case 'anythingllm':
				return 'your-model-id';
			default:
				return '';
		}
	}

	getEditableModelValue(provider = this.settings.apiProvider): string {
		if (provider === 'z_ai') {
			return this.getResolvedModel().trim() || this.getDefaultModelForProvider(provider);
		}

		return this.settings.localProviderModel.trim() || this.getDefaultModelForProvider(provider);
	}

	setProviderModel(provider: ApiProvider, model: string): void {
		const trimmed = model.trim();
		if (provider === 'z_ai') {
			if (!trimmed || trimmed === 'glm-5.1') {
				this.settings.zAiModelPreset = 'glm-5.1';
				this.settings.zAiCustomModel = '';
				return;
			}
			this.settings.zAiModelPreset = 'custom';
			this.settings.zAiCustomModel = trimmed;
			return;
		}

		this.settings.localProviderModel = trimmed || this.getDefaultModelForProvider(provider);
	}

	clearProviderStatus(clearModels = true): void {
		this.providerStatus = null;
		if (clearModels) {
			this.availableProviderModels = [];
		}
	}

	private getResolvedBaseUrl(): string {
		switch (this.settings.apiProvider) {
			case 'z_ai':
				return Z_AI_CODING_PLAN_URL;
			case 'lm_studio':
				return this.settings.localProviderBaseUrl.trim() || LM_STUDIO_BASE_URL;
			case 'ollama':
				return this.settings.localProviderBaseUrl.trim() || OLLAMA_BASE_URL;
			case 'anythingllm':
				return this.settings.anythingllmBaseUrl.trim();
			default:
				return '';
		}
	}

	private getRunEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (this.settings.apiProvider === 'z_ai') {
			env.RAG_LLM_BASE_URL = Z_AI_CODING_PLAN_URL;
			env.RAG_LLM_API_KEY = this.settings.zAiApiKey.trim();
			env.LLM_MODEL = this.getResolvedModel();
		} else if (this.settings.apiProvider === 'lm_studio' || this.settings.apiProvider === 'ollama' || this.settings.apiProvider === 'anythingllm') {
			env.RAG_LLM_BASE_URL = this.getResolvedBaseUrl();
			env.RAG_LLM_API_KEY = this.settings.localProviderApiKey.trim() || `${this.settings.apiProvider}-local`;
			env.LLM_MODEL = this.getResolvedModel();
		}
		return env;
	}

	private getProviderHeaders(): Record<string, string> {
		if (this.settings.apiProvider === 'z_ai') {
			return this.settings.zAiApiKey.trim()
				? { Authorization: `Bearer ${this.settings.zAiApiKey.trim()}` }
				: {};
		}

		if (this.settings.apiProvider === 'lm_studio' || this.settings.apiProvider === 'ollama' || this.settings.apiProvider === 'anythingllm') {
			const token = this.settings.localProviderApiKey.trim();
			return token ? { Authorization: `Bearer ${token}` } : {};
		}

		return {};
	}

	private getProviderModelsUrl(): string {
		if (this.settings.apiProvider === 'ollama') {
			const nativeBaseUrl = this.getResolvedBaseUrl().replace(/\/+$/, '').replace(/\/v1$/, '');
			return `${nativeBaseUrl}/api/tags`;
		}
		return `${this.getResolvedBaseUrl().replace(/\/+$/, '')}/models`;
	}

	private async fetchJson(url: string, headers: Record<string, string>): Promise<FetchJsonResult> {
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					...headers,
				},
				signal: controller.signal,
			});
			let body: any = null;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			return { ok: response.ok, status: response.status, body };
		} catch (error) {
			const message = error instanceof Error && error.name === 'AbortError'
				? `Request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS / 1000}s.`
				: error instanceof Error
					? error.message
					: 'Unknown request error.';
			return {
				ok: false,
				status: 0,
				body: null,
				error: message,
			};
		} finally {
			window.clearTimeout(timeout);
		}
	}

	private extractModelIds(body: any): string[] {
		if (!body) {
			return [];
		}

		if (Array.isArray(body.data)) {
			return body.data
				.map((entry: unknown) => (entry as { id?: unknown })?.id)
				.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
		}

		if (Array.isArray(body.models)) {
			return body.models
				.map((entry: unknown) => {
					const candidate = entry as { id?: unknown; name?: unknown; model?: unknown };
					return candidate?.id ?? candidate?.name ?? candidate?.model;
				})
				.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
		}

		if (Array.isArray(body.tags)) {
			return body.tags
				.map((entry: unknown) => {
					const candidate = entry as { name?: unknown; model?: unknown };
					return candidate?.name ?? candidate?.model;
				})
				.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
		}

		return [];
	}

	resetProviderUiState(provider: ApiProvider): void {
		this.availableProviderModels = [];
		this.providerStatus = null;
		if (provider === 'repo_defaults') {
			return;
		}
		if (provider === 'z_ai') {
			this.settings.zAiModelPreset = 'glm-5.1';
			this.settings.zAiCustomModel = '';
			return;
		}
		this.settings.localProviderModel = this.getDefaultModelForProvider(provider);
	}

	async testSelectedProvider(showNotice = true): Promise<ProviderTestResult> {
		if (this.settings.apiProvider === 'repo_defaults') {
			const result = { ok: true, lines: ['Repo defaults selected. No provider endpoint test to run.'] };
			this.providerStatus = result;
			if (showNotice) {
				new Notice(result.lines.join('\n'), 8000);
			}
			return result;
		}

		const baseUrl = this.getResolvedBaseUrl();
		if (!baseUrl) {
			const result = { ok: false, lines: ['Missing provider base URL.'] };
			this.providerStatus = result;
			if (showNotice) {
				new Notice(result.lines.join('\n'), 8000);
			}
			return result;
		}

		const response = await this.fetchJson(this.getProviderModelsUrl(), this.getProviderHeaders());
		this.availableProviderModels = this.extractModelIds(response.body);

		const lines = [`Endpoint: ${this.getProviderModelsUrl()}`];
		if (response.ok) {
			lines.push(`HTTP ${response.status}`);
			if (this.availableProviderModels.length > 0) {
				lines.push(`Found ${this.availableProviderModels.length} model(s).`);
			} else {
				lines.push('Connected, but no model list came back.');
			}
		} else {
			lines.push(response.status > 0 ? `HTTP ${response.status}` : 'No HTTP response');
			lines.push(response.error ?? 'Could not reach the provider endpoint.');
		}

		const result = { ok: response.ok, lines };
		this.providerStatus = result;
		if (showNotice) {
			new Notice(lines.join('\n'), 10000);
		}
		return result;
	}

	async refreshProviderModels(showNotice = true): Promise<string[]> {
		const result = await this.testSelectedProvider(showNotice);
		if (result.ok && this.availableProviderModels.length > 0) {
			const selectedModel = this.getEditableModelValue();
			if (!this.availableProviderModels.includes(selectedModel)) {
				this.setProviderModel(this.settings.apiProvider, this.availableProviderModels[0]);
				await this.saveSettings();
			}
		}
		return this.availableProviderModels;
	}

	private async ensureVaultFolder(folderPath: string): Promise<void> {
		if (folderPath === '.' || folderPath === '' || await this.app.vault.adapter.exists(folderPath)) {
			return;
		}

		const parent = path.posix.dirname(folderPath);
		if (parent !== folderPath) {
			await this.ensureVaultFolder(parent);
		}
		await this.app.vault.createFolder(folderPath);
	}

	private async validateSetup(showNotice = false): Promise<ValidationResult> {
		const lines: string[] = [];
		let ok = true;

		const repoPath = this.settings.p2sPath.trim();
		if (!repoPath) {
			ok = false;
			lines.push('Missing repo path.');
		} else if (!fs.existsSync(repoPath)) {
			ok = false;
			lines.push('Repo path does not exist.');
		} else if (!fs.existsSync(path.join(repoPath, 'paper2slides'))) {
			ok = false;
			lines.push('Repo path does not look like a Paper2Slides checkout.');
		} else {
			lines.push('Repo path looks valid.');
		}

		const envPath = repoPath ? path.join(repoPath, 'paper2slides', '.env') : '';
		const usesPluginProvider = this.settings.apiProvider !== 'repo_defaults';
		if (envPath && fs.existsSync(envPath)) {
			lines.push('Found paper2slides/.env.');
		} else if (usesPluginProvider) {
			lines.push('paper2slides/.env is missing, but the plugin will inject provider settings at runtime.');
		} else {
			ok = false;
			lines.push('Missing paper2slides/.env.');
		}

		if (this.settings.apiProvider === 'z_ai') {
			if (!this.settings.zAiApiKey.trim()) {
				ok = false;
				lines.push('Missing Z.AI API key.');
			} else {
				lines.push('Z.AI API key is set in plugin settings.');
			}
			lines.push(`Z.AI entrypoint: ${Z_AI_CODING_PLAN_URL}`);
			lines.push(`Z.AI model: ${this.getResolvedModel()}`);
		} else if (this.settings.apiProvider === 'lm_studio' || this.settings.apiProvider === 'ollama' || this.settings.apiProvider === 'anythingllm') {
			const baseUrl = this.getResolvedBaseUrl();
			if (!baseUrl) {
				ok = false;
				lines.push('Missing local provider base URL.');
			} else {
				lines.push(`Local provider endpoint: ${baseUrl}`);
			}

			if (!this.getResolvedModel()) {
				ok = false;
				lines.push('Missing local provider model id.');
			} else {
				lines.push(`Local provider model: ${this.getResolvedModel()}`);
			}
		}

		if (repoPath) {
			const pythonVersion = await this.runCommand(this.settings.pythonPath, ['--version'], repoPath);
			if (pythonVersion.ok) {
				lines.push(`Python command works: ${pythonVersion.output.trim()}`);
			} else {
				ok = false;
				lines.push(`Python command failed: ${pythonVersion.output.trim() || this.settings.pythonPath}`);
			}

			const cliCheck = await this.runCommand(this.settings.pythonPath, ['-m', 'paper2slides', '--help'], repoPath);
			if (cliCheck.ok) {
				lines.push('paper2slides CLI starts.');
			} else {
				ok = false;
				lines.push('paper2slides CLI did not start.');
			}
		}

		if (showNotice) {
			const prefix = ok ? 'Paper2Slides setup looks good.' : 'Paper2Slides setup still needs fixes.';
			new Notice([prefix, ...lines].join('\n'), 12000);
		}

		return { ok, lines };
	}

	private async runCommand(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
		return await new Promise((resolve) => {
			const child = spawn(command, args, { cwd, env: this.getRunEnv() });
			let output = '';

			child.stdout.on('data', (data) => {
				output += data.toString();
			});

			child.stderr.on('data', (data) => {
				output += data.toString();
			});

			child.on('error', (error) => {
				resolve({ ok: false, output: error.message });
			});

			child.on('close', (code) => {
				resolve({ ok: code === 0, output });
			});
		});
	}

	async runSetupCheck(showNotice = true): Promise<boolean> {
		const result = await this.validateSetup(showNotice);
		return result.ok;
	}

	private buildCliArgs(fullInputPath: string, contentType: ContentType): string[] {
		const args = [
			'-m', 'paper2slides',
			'--input', fullInputPath,
			'--content', contentType,
			'--output', this.settings.outputType,
			'--style', this.getStyleArgument(),
		];

		if (this.settings.outputType === 'slides') {
			args.push('--length', this.settings.slidesLength);
		} else {
			args.push('--density', this.settings.posterDensity);
		}

		if (this.settings.fastMode) {
			args.push('--fast');
		}

		if (this.settings.parallelWorkers > 1) {
			args.push('--parallel', String(this.settings.parallelWorkers));
		}

		return args;
	}

	async generateSlides(file: TFile) {
		if (this.activeRun) {
			new Notice(`A Paper2Slides run is already active for ${this.activeRun.file.name}. Stop it first or wait for it to finish.`);
			return;
		}

		const setupOk = await this.runSetupCheck(false);
		if (!setupOk) {
			await this.runSetupCheck(true);
			return;
		}

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice('Only local vaults are supported right now.');
			return;
		}

		const repoPath = this.settings.p2sPath.trim();
		const fullInputPath = path.join(adapter.getBasePath(), file.path);
		const contentType = this.getContentType(file);
		const args = this.buildCliArgs(fullInputPath, contentType);
		const targetDir = this.getTargetDir(file);

		new Notice(`Starting Paper2Slides for ${file.name}...`, 6000);

		const processHandle = spawn(this.settings.pythonPath, args, {
			cwd: repoPath,
			env: this.getRunEnv(),
		});

		const run: RunContext = {
			file,
			contentType,
			process: processHandle,
			startedAt: Date.now(),
			targetDir,
			logLines: [
				`Command: ${this.settings.pythonPath} ${args.join(' ')}`,
				`Started: ${new Date().toISOString()}`,
			],
		};

		this.activeRun = run;

		processHandle.on('error', async (error) => {
			this.appendLogLine(run, `Process error: ${error.message}`);
			await this.writeRunLog(run, false);
			this.activeRun = null;
			new Notice(`Could not start ${this.settings.pythonPath}. Check the Python command in settings.`);
		});

		processHandle.stdout.on('data', (data) => {
			const output = data.toString();
			console.log(`Paper2Slides stdout: ${output}`);
			for (const line of output.split('\n')) {
				this.appendLogLine(run, line);
				if (line.includes('Starting Stage:')) {
					new Notice(`Paper2Slides: ${line.trim()}`, 4000);
				}
			}
		});

		processHandle.stderr.on('data', (data) => {
			const output = data.toString();
			console.error(`Paper2Slides stderr: ${output}`);
			for (const line of output.split('\n')) {
				this.appendLogLine(run, `[stderr] ${line}`);
			}
		});

		processHandle.on('close', async (code) => {
			this.appendLogLine(run, `Exited with code: ${code}`);
			const success = code === 0;
			if (success) {
				await this.importLatestOutputs(run.file, run.contentType, run.startedAt);
				await this.writeRunLog(run, true);
				new Notice(`Paper2Slides finished for ${run.file.name}. Imported the latest outputs into ${targetDir}.`, 8000);
			} else {
				await this.writeRunLog(run, false);
				new Notice(`Paper2Slides failed for ${run.file.name}. Check ${path.posix.join(targetDir, 'last-run.log')}.`, 10000);
			}
			this.activeRun = null;
		});
	}

	async stopCurrentRun() {
		if (!this.activeRun) {
			new Notice('No Paper2Slides run is active right now.');
			return;
		}

		const run = this.activeRun;
		this.appendLogLine(run, 'Stopping run on user request.');
		run.process.kill('SIGTERM');
		setTimeout(() => {
			if (this.activeRun === run) {
				run.process.kill('SIGKILL');
			}
		}, 3000);
		new Notice(`Stopping Paper2Slides for ${run.file.name}...`);
	}

	private collectGeneratedFiles(dir: string): string[] {
		if (!fs.existsSync(dir)) {
			return [];
		}

		const collected: string[] = [];
		for (const name of fs.readdirSync(dir)) {
			const currentPath = path.join(dir, name);
			const stat = fs.statSync(currentPath);
			if (stat.isDirectory()) {
				collected.push(...this.collectGeneratedFiles(currentPath));
			} else if (name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.md')) {
				collected.push(currentPath);
			}
		}

		return collected;
	}

	private findLatestRunDir(modeDir: string): string | null {
		if (!fs.existsSync(modeDir)) {
			return null;
		}

		const matches: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const currentPath = path.join(dir, name);
				const stat = fs.statSync(currentPath);
				if (!stat.isDirectory()) {
					continue;
				}
				if (TIMESTAMP_DIR_PATTERN.test(name)) {
					matches.push(currentPath);
				}
				walk(currentPath);
			}
		};

		walk(modeDir);
		matches.sort((a, b) => {
			const nameCompare = path.basename(b).localeCompare(path.basename(a));
			if (nameCompare !== 0) {
				return nameCompare;
			}
			return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
		});
		return matches[0] ?? null;
	}

	private getModeDir(sourceFile: TFile, contentType: ContentType, fastMode = this.settings.fastMode): string {
		return path.join(
			this.settings.p2sPath.trim(),
			'outputs',
			sourceFile.basename,
			contentType,
			fastMode ? 'fast' : 'normal',
		);
	}

	private async writeVaultFile(vaultPath: string, sourcePath: string): Promise<void> {
		const data = fs.readFileSync(sourcePath);
		if (sourcePath.endsWith('.md') || sourcePath.endsWith('.log')) {
			const content = data.toString('utf8');
			if (await this.app.vault.adapter.exists(vaultPath)) {
				await this.app.vault.adapter.write(vaultPath, content);
			} else {
				await this.app.vault.create(vaultPath, content);
			}
			return;
		}

		const binary = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		if (await this.app.vault.adapter.exists(vaultPath)) {
			await this.app.vault.adapter.writeBinary(vaultPath, binary);
		} else {
			await this.app.vault.createBinary(vaultPath, binary);
		}
	}

	private async writeRunLog(run: RunContext, success: boolean): Promise<void> {
		if (!this.settings.saveRunLog) {
			return;
		}

		await this.ensureVaultFolder(run.targetDir);
		const body = [
			...run.logLines,
			`Finished: ${new Date().toISOString()}`,
			`Status: ${success ? 'success' : 'failed'}`,
		].join('\n');

		await this.writeVaultFile(path.posix.join(run.targetDir, 'last-run.log'), this.createTempTextFile(body));
	}

	private createTempTextFile(content: string): string {
		const tempPath = path.join(this.app.vault.configDir, 'plugins', 'paper2slides-obsidian', 'tmp-last-run.log');
		fs.mkdirSync(path.dirname(tempPath), { recursive: true });
		fs.writeFileSync(tempPath, content, 'utf8');
		return tempPath;
	}

	async importLatestOutputs(sourceFile: TFile, contentType: ContentType, runStartedAt?: number) {
		const preferredModeDir = this.getModeDir(sourceFile, contentType, this.settings.fastMode);
		const fallbackModeDir = this.getModeDir(sourceFile, contentType, !this.settings.fastMode);
		let modeDir = preferredModeDir;
		let latestRunDir = this.findLatestRunDir(preferredModeDir);
		if (!latestRunDir) {
			modeDir = fallbackModeDir;
			latestRunDir = this.findLatestRunDir(fallbackModeDir);
		}
		const summaryPath = path.join(modeDir, 'summary.md');
		const targetDir = this.getTargetDir(sourceFile);

		const sourcePaths = new Set<string>();
		if (latestRunDir) {
			for (const filePath of this.collectGeneratedFiles(latestRunDir)) {
				if (!runStartedAt || fs.statSync(filePath).mtimeMs >= runStartedAt - 2000) {
					sourcePaths.add(filePath);
				}
			}
		}

		if (sourcePaths.size === 0 && latestRunDir) {
			for (const filePath of this.collectGeneratedFiles(latestRunDir)) {
				sourcePaths.add(filePath);
			}
		}

		if (fs.existsSync(summaryPath)) {
			sourcePaths.add(summaryPath);
		}

		if (sourcePaths.size === 0) {
			new Notice('Paper2Slides finished, but no output files were found to import.');
			return;
		}

		await this.ensureVaultFolder(targetDir);

		let importedCount = 0;
		for (const sourcePath of sourcePaths) {
			const fileName = path.basename(sourcePath);
			const vaultPath = path.posix.join(targetDir, fileName);
			await this.writeVaultFile(vaultPath, sourcePath);
			importedCount += 1;
		}

		new Notice(`Imported ${importedCount} files into ${targetDir}`, 7000);
	}

	async reimportLatestOutputs(file: TFile) {
		const setupOk = await this.runSetupCheck(false);
		if (!setupOk) {
			await this.runSetupCheck(true);
			return;
		}

		await this.importLatestOutputs(file, this.getContentType(file));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class Paper2SlidesSettingTab extends PluginSettingTab {
	plugin: Paper2SlidesPlugin;

	constructor(app: App, plugin: Paper2SlidesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Paper2Slides settings' });
		containerEl.createEl('p', {
			text: 'You can trigger the plugin from the settings tab, the left ribbon, the command palette, or the file right-click menu.',
		});

		const activeFile = this.app.workspace.getActiveFile();
		const activeFileDesc = activeFile && this.plugin.isSupportedSource(activeFile)
			? `Current file: ${activeFile.path}`
			: 'Open a PDF or Markdown note to run Paper2Slides from here.';

		new Setting(containerEl)
			.setName('Current file')
			.setDesc(activeFileDesc)
			.addButton((button) => button
				.setButtonText('Generate')
				.setDisabled(!activeFile || !this.plugin.isSupportedSource(activeFile) || !!this.plugin.activeRun)
				.onClick(async () => {
					if (activeFile && this.plugin.isSupportedSource(activeFile)) {
						await this.plugin.generateSlides(activeFile);
						this.display();
					}
				}))
			.addButton((button) => button
				.setButtonText('Re-import')
				.setDisabled(!activeFile || !this.plugin.isSupportedSource(activeFile) || !!this.plugin.activeRun)
				.onClick(async () => {
					if (activeFile && this.plugin.isSupportedSource(activeFile)) {
						await this.plugin.reimportLatestOutputs(activeFile);
						this.display();
					}
				}))
			.addButton((button) => button
				.setButtonText(this.plugin.activeRun ? 'Stop run' : 'No run')
				.setDisabled(!this.plugin.activeRun)
				.onClick(async () => {
					await this.plugin.stopCurrentRun();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Run setup check')
			.setDesc('Verify Python, repo path, CLI startup, and paper2slides/.env.')
			.addButton((button) => button
				.setButtonText('Check now')
				.onClick(async () => {
					await this.plugin.runSetupCheck(true);
				}));

		new Setting(containerEl)
			.setName('Python command')
			.setDesc('Usually python3. Point this to your venv only if you actually need to.')
			.addText((text) => text
				.setPlaceholder('python3')
				.setValue(this.plugin.settings.pythonPath)
				.onChange(async (value) => {
					this.plugin.settings.pythonPath = value.trim() || 'python3';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Paper2Slides repo path')
			.setDesc('Absolute path to your local Paper2Slides checkout.')
			.addText((text) => text
				.setPlaceholder('/path/to/Paper2Slides')
				.setValue(this.plugin.settings.p2sPath)
				.onChange(async (value) => {
					this.plugin.settings.p2sPath = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Import folder in the vault')
			.setDesc('Imported files land here, grouped by source file name.')
			.addText((text) => text
				.setPlaceholder('Paper2Slides')
				.setValue(this.plugin.settings.importRoot)
				.onChange(async (value) => {
					this.plugin.settings.importRoot = value.trim() || 'Paper2Slides';
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'API' });

		new Setting(containerEl)
			.setName('API provider')
			.setDesc('Use the repo defaults, or point Paper2Slides at a specific hosted or local model endpoint.')
			.addDropdown((dropdown) => dropdown
				.addOption('repo_defaults', 'Use repo defaults')
				.addOption('z_ai', 'Z AI')
				.addOption('lm_studio', 'LM Studio')
				.addOption('ollama', 'Ollama')
				.addOption('anythingllm', 'AnythingLLM')
				.setValue(this.plugin.settings.apiProvider)
				.onChange(async (value: ApiProvider) => {
					this.plugin.settings.apiProvider = value;
					if (value === 'lm_studio') {
						this.plugin.settings.localProviderBaseUrl = LM_STUDIO_BASE_URL;
					}
					if (value === 'ollama') {
						this.plugin.settings.localProviderBaseUrl = OLLAMA_BASE_URL;
					}
					this.plugin.resetProviderUiState(value);
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Provider check')
			.setDesc('Ping the selected provider endpoint from inside Obsidian.')
			.addButton((button) => button
				.setButtonText('Test provider')
				.onClick(async () => {
					await this.plugin.testSelectedProvider(true);
					this.display();
				}));

		if (this.plugin.providerStatus) {
			const statusEl = containerEl.createDiv({ cls: 'paper2slides-provider-status' });
			statusEl.createEl('strong', {
				text: this.plugin.providerStatus.ok ? '✅ Provider reachable' : '❌ Provider check failed',
			});
			for (const line of this.plugin.providerStatus.lines) {
				statusEl.createEl('div', { text: line });
			}
		}

		if (this.plugin.settings.apiProvider === 'z_ai') {
			new Setting(containerEl)
				.setName('Z AI entrypoint')
				.setDesc('Currently wired to the International Coding Plan endpoint.')
					.addDropdown((dropdown) => dropdown
						.addOption('international_coding_plan', 'International Coding Plan')
						.setValue(this.plugin.settings.zAiEntrypoint)
						.onChange(async (value: ZAiEntrypoint) => {
							this.plugin.settings.zAiEntrypoint = value;
							this.plugin.clearProviderStatus();
							await this.plugin.saveSettings();
							this.display();
						}));

			new Setting(containerEl)
				.setName('Z AI API key')
				.setDesc('Stored in the plugin settings and injected at runtime as RAG_LLM_API_KEY.')
				.addText((text) => text
					.setPlaceholder('zai-...')
					.setValue(this.plugin.settings.zAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.zAiApiKey = value.trim();
						this.plugin.clearProviderStatus();
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Model')
				.setDesc('Refresh the live model list, or type a model id directly.')
				.addText((text) => text
					.setPlaceholder(this.plugin.getDefaultModelForProvider('z_ai'))
					.setValue(this.plugin.getEditableModelValue('z_ai'))
					.onChange(async (value) => {
						this.plugin.setProviderModel('z_ai', value);
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Z AI model list')
				.setDesc('Fetch the current models exposed by the selected endpoint.')
				.addButton((button) => button
					.setButtonText('Refresh models')
					.onClick(async () => {
						await this.plugin.refreshProviderModels(true);
						this.display();
					}));

			if (this.plugin.availableProviderModels.length > 0) {
				new Setting(containerEl)
					.setName('Detected models')
					.setDesc('Choose one of the models returned by Z AI.')
					.addDropdown((dropdown) => {
						for (const model of this.plugin.availableProviderModels) {
							dropdown.addOption(model, model);
						}
						const selected = this.plugin.availableProviderModels.includes(this.plugin.getEditableModelValue('z_ai'))
							? this.plugin.getEditableModelValue('z_ai')
							: this.plugin.availableProviderModels[0];
						dropdown.setValue(selected);
						dropdown.onChange(async (value) => {
							this.plugin.setProviderModel('z_ai', value);
							await this.plugin.saveSettings();
						});
					});
			}
		} else if (this.plugin.settings.apiProvider === 'lm_studio' || this.plugin.settings.apiProvider === 'ollama') {
			const providerName = this.plugin.settings.apiProvider === 'lm_studio' ? 'LM Studio' : 'Ollama';
			const defaultBaseUrl = this.plugin.settings.apiProvider === 'lm_studio' ? LM_STUDIO_BASE_URL : OLLAMA_BASE_URL;

			new Setting(containerEl)
				.setName(`${providerName} base URL`)
				.setDesc('OpenAI-compatible endpoint used for the Paper2Slides run.')
				.addText((text) => text
					.setPlaceholder(defaultBaseUrl)
					.setValue(this.plugin.settings.localProviderBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.localProviderBaseUrl = value.trim() || defaultBaseUrl;
						this.plugin.clearProviderStatus();
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(`${providerName} model`)
				.setDesc('Model id exposed by your local server.')
				.addText((text) => text
					.setPlaceholder(this.plugin.getDefaultModelForProvider(this.plugin.settings.apiProvider))
					.setValue(this.plugin.getEditableModelValue())
					.onChange(async (value) => {
						this.plugin.setProviderModel(this.plugin.settings.apiProvider, value);
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(`${providerName} API key`)
				.setDesc('Optional. If blank, the plugin injects a harmless local placeholder token.')
				.addText((text) => text
					.setPlaceholder('optional')
					.setValue(this.plugin.settings.localProviderApiKey)
					.onChange(async (value) => {
						this.plugin.settings.localProviderApiKey = value.trim();
						this.plugin.clearProviderStatus();
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(`${providerName} model list`)
				.setDesc(`Fetch the current model list from ${this.plugin.settings.apiProvider === 'ollama' ? '/api/tags' : '/models'}.`)
				.addButton((button) => button
					.setButtonText('Refresh models')
					.onClick(async () => {
						await this.plugin.refreshProviderModels(true);
						this.display();
					}));

			if (this.plugin.availableProviderModels.length > 0) {
				new Setting(containerEl)
					.setName(`${providerName} detected models`)
					.setDesc('Choose one of the models returned by the local server.')
					.addDropdown((dropdown) => {
						for (const model of this.plugin.availableProviderModels) {
							dropdown.addOption(model, model);
						}
						const selected = this.plugin.availableProviderModels.includes(this.plugin.settings.localProviderModel)
							? this.plugin.settings.localProviderModel
							: this.plugin.availableProviderModels[0];
						dropdown.setValue(selected);
						dropdown.onChange(async (value) => {
							this.plugin.setProviderModel(this.plugin.settings.apiProvider, value);
							await this.plugin.saveSettings();
						});
					});
			}
		} else if (this.plugin.settings.apiProvider === 'anythingllm') {
			new Setting(containerEl)
				.setName('AnythingLLM base URL')
				.setDesc('Use the OpenAI-compatible endpoint exposed by your local AnythingLLM setup.')
				.addText((text) => text
					.setPlaceholder('http://localhost:3001/api/v1')
					.setValue(this.plugin.settings.anythingllmBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.anythingllmBaseUrl = value.trim();
						this.plugin.clearProviderStatus();
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('AnythingLLM model')
				.setDesc('Model id served through your local AnythingLLM endpoint.')
				.addText((text) => text
					.setPlaceholder(this.plugin.getDefaultModelForProvider('anythingllm'))
					.setValue(this.plugin.getEditableModelValue('anythingllm'))
					.onChange(async (value) => {
						this.plugin.setProviderModel('anythingllm', value);
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('AnythingLLM API key')
				.setDesc('Optional here, but fill it in if your AnythingLLM API access requires one.')
				.addText((text) => text
					.setPlaceholder('optional')
					.setValue(this.plugin.settings.localProviderApiKey)
					.onChange(async (value) => {
						this.plugin.settings.localProviderApiKey = value.trim();
						this.plugin.clearProviderStatus();
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('AnythingLLM check')
				.setDesc('Test the endpoint and fetch the live model list from /models.')
				.addButton((button) => button
					.setButtonText('Refresh models')
					.onClick(async () => {
						await this.plugin.refreshProviderModels(true);
						this.display();
					}));

			if (this.plugin.availableProviderModels.length > 0) {
				new Setting(containerEl)
					.setName('AnythingLLM detected models')
					.setDesc('Choose one of the models returned by the endpoint.')
					.addDropdown((dropdown) => {
						for (const model of this.plugin.availableProviderModels) {
							dropdown.addOption(model, model);
						}
						const selected = this.plugin.availableProviderModels.includes(this.plugin.settings.localProviderModel)
							? this.plugin.settings.localProviderModel
							: this.plugin.availableProviderModels[0];
						dropdown.setValue(selected);
						dropdown.onChange(async (value) => {
							this.plugin.setProviderModel('anythingllm', value);
							await this.plugin.saveSettings();
						});
					});
			}
		}

		containerEl.createEl('h3', { text: 'Generation' });

		new Setting(containerEl)
			.setName('Output type')
			.setDesc('Generate either slides or a poster.')
			.addDropdown((dropdown) => dropdown
				.addOption('slides', 'Slides')
				.addOption('poster', 'Poster')
				.setValue(this.plugin.settings.outputType)
				.onChange(async (value: OutputType) => {
					this.plugin.settings.outputType = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.outputType === 'slides') {
			new Setting(containerEl)
				.setName('Slides length')
				.setDesc('Passed through to Paper2Slides as --length.')
				.addDropdown((dropdown) => dropdown
					.addOption('short', 'Short')
					.addOption('medium', 'Medium')
					.addOption('long', 'Long')
					.setValue(this.plugin.settings.slidesLength)
					.onChange(async (value: SlidesLength) => {
						this.plugin.settings.slidesLength = value;
						await this.plugin.saveSettings();
					}));
		} else {
			new Setting(containerEl)
				.setName('Poster density')
				.setDesc('Passed through to Paper2Slides as --density.')
				.addDropdown((dropdown) => dropdown
					.addOption('sparse', 'Sparse')
					.addOption('medium', 'Medium')
					.addOption('dense', 'Dense')
					.setValue(this.plugin.settings.posterDensity)
					.onChange(async (value: PosterDensity) => {
						this.plugin.settings.posterDensity = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Style preset')
			.setDesc('Use a built-in style or switch to custom and type your own prompt below.')
			.addDropdown((dropdown) => dropdown
				.addOption('academic', 'Academic')
				.addOption('doraemon', 'Doraemon')
				.addOption('custom', 'Custom')
				.setValue(this.plugin.settings.style)
				.onChange(async (value: StylePreset) => {
					this.plugin.settings.style = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.style === 'custom') {
			new Setting(containerEl)
				.setName('Custom style prompt')
				.setDesc('Passed straight through as the style argument.')
				.addTextArea((text) => text
					.setPlaceholder('Clean editorial slides with warm neutrals and subtle diagrams.')
					.setValue(this.plugin.settings.customStyle)
					.onChange(async (value) => {
						this.plugin.settings.customStyle = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Fast mode')
			.setDesc('Skip RAG indexing. Better for quick passes and smaller inputs.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.fastMode)
				.onChange(async (value) => {
					this.plugin.settings.fastMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Parallel workers')
			.setDesc('Only used when set above 1.')
			.addText((text) => text
				.setPlaceholder('1')
				.setValue(String(this.plugin.settings.parallelWorkers))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.parallelWorkers = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Save run log')
			.setDesc('Write last-run.log into the imported output folder.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.saveRunLog)
				.onChange(async (value) => {
					this.plugin.settings.saveRunLog = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Where to use it' });
		containerEl.createEl('p', {
			text: 'Use the ribbon button, command palette, or the right-click menu on a PDF or Markdown file. The plugin also exposes a re-import command and a stop command for long runs.',
		});
	}
}
