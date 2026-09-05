import { autoUpdater } from "electron-updater";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import type { UpdateStatus } from "@shared/types";
import { BUILD_CHANNEL } from "./build-flavor";

/**
 * Updater — Wraps electron-updater's autoUpdater singleton.
 *
 * Pushes update lifecycle events to the renderer via IPC.
 */
export class Updater {
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.sendStatus({ state: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      this.sendStatus({
        state: "available",
        info: {
          version: info.version,
          releaseNotes: this.formatNotes(info.releaseNotes),
        },
      });
    });

    autoUpdater.on("update-not-available", (info) => {
      this.sendStatus({
        state: "not-available",
        info: { version: info.version },
      });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.sendStatus({
        state: "downloading",
        progress: {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.sendStatus({
        state: "downloaded",
        info: {
          version: info.version,
          releaseNotes: this.formatNotes(info.releaseNotes),
        },
      });
    });

    autoUpdater.on("error", (err) => {
      this.sendStatus({ state: "error", error: this.formatError(err.message) });
    });
  }

  /** Bind to the main window for pushing status events. */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /** Trigger an update check. Safe to call at any time. */
  checkForUpdates(): void {
    if (BUILD_CHANNEL === "internal") {
      this.sendStatus({ state: "not-available", info: { version: app.getVersion() } });
      return;
    }
    // 开发模式下跳过，避免 electron-updater 输出 "Skip checkForUpdates" 警告
    if (!app.isPackaged) {
      this.sendStatus({ state: "not-available", info: { version: app.getVersion() } });
      return;
    }
    autoUpdater.checkForUpdates().catch((err) => {
      this.sendStatus({ state: "error", error: err.message });
    });
  }

  /** Quit and install the downloaded update. */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  private sendStatus(status: UpdateStatus): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("update:status", status);
    }
  }

  private formatNotes(
    notes: string | Array<{ note: string | null }> | undefined | null,
  ): string | undefined {
    if (!notes) return undefined;
    if (typeof notes === "string") return notes;
    return notes.map((n) => n.note ?? "").join("\n");
  }

  private formatError(message: string): string {
    if (
      process.platform === "darwin" &&
      /code signature|did not satisfy designated requirement|not signed|代码对象根本未签名/i.test(message)
    ) {
      return `${message}\n\n当前 macOS 更新包未通过代码签名校验。请从 GitHub Release 手动下载安装最新 DMG，或重新发布已签名/已公证的 macOS 安装包。`;
    }
    return message;
  }
}
