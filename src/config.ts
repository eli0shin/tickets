import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  OperationResult,
  TicketsConfig,
  UpdateBehavior,
} from './types.ts';

export function getConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configDir = xdgConfigHome
    ? join(xdgConfigHome, 'tickets')
    : join(homedir(), '.config', 'tickets');
  return join(configDir, 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidUpdateBehavior(value: unknown): boolean {
  return value === 'auto' || value === 'notify' || value === 'off';
}

function isTicketsConfig(value: unknown): value is TicketsConfig {
  if (!isRecord(value)) return false;

  if (value.config !== undefined) {
    if (!isRecord(value.config)) return false;
    if (
      value.config.updateBehavior !== undefined &&
      !isValidUpdateBehavior(value.config.updateBehavior)
    ) {
      return false;
    }
    if (
      value.config.updateCheckIntervalHours !== undefined &&
      typeof value.config.updateCheckIntervalHours !== 'number'
    ) {
      return false;
    }
  }

  return true;
}

export async function readConfig(
  configPath: string
): Promise<OperationResult<TicketsConfig>> {
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return { success: true, data: {} };
  }

  try {
    const content: unknown = await file.json();
    if (!isTicketsConfig(content)) {
      return { success: false, error: 'Invalid config file format' };
    }
    return { success: true, data: content };
  } catch {
    return { success: false, error: 'Failed to parse config file' };
  }
}

export function getUpdateBehavior(config: TicketsConfig): UpdateBehavior {
  return config.config?.updateBehavior ?? 'auto';
}

export function getUpdateCheckInterval(config: TicketsConfig): number {
  return config.config?.updateCheckIntervalHours ?? 24;
}
