import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export function anthropicUsageProviderSettings(settings) {
  return { ...settings, tokenInjection: "config-dir" };
}

export async function readAnthropicUsage(query) {
  return query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
    skipBehaviors: true,
  });
}

export async function packageRoot() {
  const executable = process.env.SENPI_BIN || Bun.which("senpi");
  if (!executable) throw new Error("senpi_not_found");
  let directory = dirname(await realpath(executable));
  while (directory !== dirname(directory)) {
    if (await Bun.file(join(directory, "package.json")).exists()) {
      const pkg = await Bun.file(join(directory, "package.json")).json();
      if (pkg.name === "@code-yeongyu/senpi") return directory;
    }
    directory = dirname(directory);
  }
  throw new Error("senpi_package_not_found");
}

export async function nativeAnthropicUsage(root, accountName) {
  const [authLane, sdk, executable, settings, { AuthStorage }, accounts, affinity] = await Promise.all([
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/auth-lane.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/sdk-boundary.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/executable.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/settings.js")),
    import(join(root, "dist/core/auth-storage.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/accounts.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/affinity.js")),
  ]);
  await sdk.loadClaudeAgentSdk();
  const providerSettings = anthropicUsageProviderSettings(
    settings.loadAnthropicSubscriptionProviderSettingsFromDisk(process.cwd()),
  );
  if (accountName) providerSettings.pinnedAccount = accountName;
  const storage = AuthStorage.create();
  storage.reload();
  const credential = storage.get("anthropic-subscription");
  const configuredAccounts = credential?.type === "oauth"
    ? accounts.listAccounts(credential, name => process.env[name])
    : [];
  const selectedAccount = affinity.selectAccount(configuredAccounts, {
    pinnedAccount: providerSettings.pinnedAccount ?? credential?.pinned,
  });
  const controller = new AbortController();
  const queryReady = Promise.withResolvers();
  let sdkQuery;
  async function* idlePrompt() {
    await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
  }
  const messages = authLane.queryWithAuthLane({
    prompt: idlePrompt(),
    query: sdk.getSdkBoundary().query,
    providerSettings,
    signal: controller.signal,
    buildOptions: () => ({
      cwd: process.cwd(),
      tools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      pathToClaudeCodeExecutable: executable.resolveClaudeCodeRun(executable.defaultExecutableDeps()).executable,
      abortController: controller,
    }),
    onQuery: queryReady.resolve,
  });
  let pumpError;
  const pump = (async () => {
    try {
      for await (const _message of messages) {
        // The idle prompt emits no model messages; iteration keeps the control channel alive.
      }
    } catch (error) {
      queryReady.reject(error);
      if (!controller.signal.aborted) pumpError = error;
    }
  })();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("usage_timeout")), 10000);
  });
  let result;
  try {
    sdkQuery = await Promise.race([queryReady.promise, deadline]);
    result = await Promise.race([readAnthropicUsage(sdkQuery), deadline]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    sdkQuery?.close();
    await pump;
  }
  if (pumpError) throw pumpError;
  return { usage: result, accountName: selectedAccount.name };
}
