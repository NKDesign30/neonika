import type { ReactiveController, ReactiveControllerHost } from "lit";
import { i18n } from "./translate.js";

// Re-renders a Lit host whenever the active locale changes.
export class I18nController implements ReactiveController {
  private unsubscribe?: () => void;

  constructor(private readonly host: ReactiveControllerHost) {
    this.host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = i18n.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
  }
}
