export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
}

/** Версия сборки интерфейса (§30.1), встроена Vite при сборке. */
export const webBuild: BuildInfo = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  builtAt: __APP_BUILD_DATE__,
};
