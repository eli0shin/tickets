import { dirname } from 'node:path';
import type { UpdateCommandOutcome } from '../types.ts';
import {
  fetchLatestVersion,
  isNewerVersion,
  downloadBinary,
  replaceBinary,
} from '../update.ts';

export type UpdateDependencies = {
  readonly fetchLatestVersion: typeof fetchLatestVersion;
  readonly isNewerVersion: typeof isNewerVersion;
  readonly downloadBinary: typeof downloadBinary;
  readonly replaceBinary: typeof replaceBinary;
};

const defaultDependencies = {
  fetchLatestVersion,
  isNewerVersion,
  downloadBinary,
  replaceBinary,
} satisfies UpdateDependencies;

export async function updateCommand(
  version: string,
  binaryPath: string,
  dependencies: UpdateDependencies = defaultDependencies
): Promise<UpdateCommandOutcome> {
  const messages = [`Current version: ${version}`, 'Checking for updates...'];

  const releaseResult = await dependencies.fetchLatestVersion();
  if (!releaseResult.success) {
    return failure(
      messages,
      `Error checking for updates: ${releaseResult.error}`
    );
  }

  const { version: latestVersion, downloadUrl } = releaseResult.data;

  if (!dependencies.isNewerVersion(version, latestVersion)) {
    return success([...messages, `Already on latest version (v${version})`]);
  }

  messages.push(`Updating to v${latestVersion}...`);

  const binaryDir = dirname(binaryPath);
  const downloadResult = await dependencies.downloadBinary(
    downloadUrl,
    binaryDir
  );
  if (!downloadResult.success) {
    return failure(
      messages,
      `Error downloading update: ${downloadResult.error}`
    );
  }

  const replaceResult = await dependencies.replaceBinary(
    downloadResult.data,
    binaryPath
  );
  if (!replaceResult.success) {
    return failure(messages, `Error installing update: ${replaceResult.error}`);
  }

  return success([...messages, `Updated to v${latestVersion}`]);
}

function success(messages: readonly string[]): UpdateCommandOutcome {
  return { messages, outcome: { ok: true, value: undefined } };
}

function failure(
  messages: readonly string[],
  message: string
): UpdateCommandOutcome {
  return {
    messages,
    outcome: { ok: false, failure: { kind: 'message', message } },
  };
}
