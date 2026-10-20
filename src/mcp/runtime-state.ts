/**
 * Mutable state the MCP server keeps between tool calls: which tools are
 * enabled, and whether the embedder is usable.
 *
 * The registry can change while the process runs (a hot-reloaded tool group
 * config, an embedder that comes back), so this state is updated in place
 * rather than captured at boot.
 */
import { getDisabledTools, getEnabledToolNames, watchToolGroupConfig, type ToolGroupConfig } from '../config/tool-groups.ts';
import { formatEmbedderDegradedWarning, setEmbedderRuntimeStatus, type EmbedderRuntimeStatus } from '../vector/embedder-config.ts';
import type { ToolContext } from '../tools/types.ts';

export class McpRuntimeState {
  disabledTools = new Set<string>();
  enabledToolNames: string[] = [];
  explicitDisabledTools = new Set<string>();
  explicitEnabledTools = new Set<string>();
  vectorStatus: ToolContext['vectorStatus'] = 'unknown';
  vectorReason: string | undefined;
  embedderProvider: string | undefined;
  private lastEmbedderWarning: string | undefined;

  applyToolGroupConfig(config: ToolGroupConfig): void {
    this.disabledTools = getDisabledTools(config);
    this.enabledToolNames = getEnabledToolNames(config);
    this.explicitDisabledTools = new Set(config.disabled_tools ?? []);
    this.explicitEnabledTools = new Set(config.enabled_tools ?? []);
  }

  logToolGroupConfig(config: ToolGroupConfig): void {
    const disabledGroups = Object.entries(config).filter(([, v]) => typeof v === 'boolean' && !v).map(([k]) => k);
    if (disabledGroups.length) console.error(`[ToolGroups] Disabled groups: ${disabledGroups.join(', ')}`);
    if (config.disabled_tools?.length) console.error(`[ToolGroups] disabled_tools: ${config.disabled_tools.join(', ')}`);
    if (config.enabled_tools?.length) console.error(`[ToolGroups] enabled_tools (whitelist): ${config.enabled_tools.join(', ')}`);
  }

  /**
   * Watch the tool group config and apply it on change. Returns the stop
   * function, or null when the config is pinned or hot reload is off.
   */
  watchToolGroupsIfNeeded(
    watch: typeof watchToolGroupConfig,
    repoRoot: string,
    pinnedConfig?: ToolGroupConfig,
  ): (() => void) | null {
    if (pinnedConfig || process.env.ORACLE_TOOL_GROUPS_HOT_RELOAD === '0') return null;
    return watch((next) => {
      this.applyToolGroupConfig(next);
      this.logToolGroupConfig(next);
      console.error('[ToolGroups] Reloaded');
    }, repoRoot);
  }

  applyEmbedderStatus(status: EmbedderRuntimeStatus): void {
    setEmbedderRuntimeStatus(status);
    this.embedderProvider = status.provider;
    if (status.status === 'connected') {
      this.vectorStatus = 'connected';
      this.vectorReason = undefined;
      this.lastEmbedderWarning = undefined;
      return;
    }
    if (status.status !== 'degraded') return;
    this.vectorStatus = 'degraded';
    this.vectorReason = status.reason;
    const warning = formatEmbedderDegradedWarning(status.provider, status.reason ?? 'unknown');
    if (this.lastEmbedderWarning !== warning) {
      console.error(warning);
      this.lastEmbedderWarning = warning;
    }
  }
}
