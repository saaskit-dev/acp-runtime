export type CommandLaunchConfig = {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
};

type NpxCommandLaunchOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  executable?: string;
  packageName?: string;
  packageSpec?: string;
  version?: string;
};

export function resolvePackageSpec(
  packageName: string,
  version?: string,
): string {
  if (!version || version.trim().length === 0) {
    return packageName;
  }
  return `${packageName}@${version}`;
}

export function inferExecutableFromPackageSpec(packageSpec: string): string {
  const packageWithoutVersion = packageSpec.startsWith("@")
    ? packageSpec.slice(0, packageSpec.lastIndexOf("@"))
    : packageSpec.split("@")[0];

  return packageWithoutVersion.split("/").pop() ?? packageWithoutVersion;
}

export function createNpxCommandLaunch(
  options: NpxCommandLaunchOptions,
): CommandLaunchConfig {
  const {
    args = [],
    env,
    executable,
    packageName,
    packageSpec,
    version,
  } = options;
  const resolvedPackageSpec = packageSpec ?? resolvePackageSpec(packageName!, version);
  const resolvedExecutable =
    executable ?? inferExecutableFromPackageSpec(resolvedPackageSpec);

  return {
    command: "npx",
    args: ["--yes", "-p", resolvedPackageSpec, resolvedExecutable, ...args],
    env,
  };
}
