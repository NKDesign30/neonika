import { ButtonStyle, ComponentType } from "discord.js";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIComponentInMessageActionRow,
  APISelectMenuOption,
  APIStringSelectComponent
} from "discord.js";

/**
 * Pure, side-effect-free builder + validator for Discord message components
 * (interactive ActionRows: buttons and string-select menus). Mirrors
 * discordRichPayload.ts: it translates a leak-safe Neon component model into the
 * raw `APIActionRowComponent` shape that `channel.send({ components })` accepts,
 * enforcing Discord's documented hard limits up front so the gated canary
 * transport never hands discord.js a payload the API would reject at send time.
 *
 * Scope is the classic (V1) interactive components only — buttons and string
 * selects inside action rows. The richer V2 container/section/media surface and
 * inbound component-click dispatch (modals, custom-id routing) are deliberately
 * out of this slice; they are a separate, much larger block.
 *
 * No network, no client, no token — this is the read-only half of the component
 * capability. The gated transport (the only live-side-effect site) consumes the
 * validated output. Validation uses a Result shape (no throw for caller-input
 * errors) so the transport can stay suppressed and surface the reason.
 */

// Discord API hard limits (stable platform constants, not discord.js-specific).
export const NEON_DISCORD_COMPONENT_LIMITS = {
  rowsPerMessage: 5,
  buttonsPerRow: 5,
  buttonLabel: 80,
  customId: 100,
  selectPlaceholder: 150,
  selectOptions: 25,
  selectOptionLabel: 100,
  selectOptionValue: 100,
  selectOptionDescription: 100,
  selectValues: 25
} as const;

export type TNeonDiscordButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";

export interface INeonDiscordButton {
  readonly label: string;
  readonly style: TNeonDiscordButtonStyle;
  /** Required for non-link buttons; mutually exclusive with `url`. Max 100 chars. */
  readonly customId?: string;
  /** Required for link buttons; mutually exclusive with `customId`. Must be http(s). */
  readonly url?: string;
  /** Optional unicode emoji name (e.g. "👀"). Custom emoji ids are out of scope. */
  readonly emoji?: string;
  readonly disabled?: boolean;
}

export interface INeonDiscordSelectOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly default?: boolean;
}

export interface INeonDiscordSelect {
  readonly customId: string;
  readonly options: readonly INeonDiscordSelectOption[];
  readonly placeholder?: string;
  readonly minValues?: number;
  readonly maxValues?: number;
  readonly disabled?: boolean;
}

/** An action row is either up to 5 buttons, or exactly one select menu. */
export type TNeonDiscordActionRow =
  | { readonly buttons: readonly INeonDiscordButton[] }
  | { readonly select: INeonDiscordSelect };

export type TNeonDiscordComponentBuildResult =
  | { readonly ok: true; readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[] }
  | { readonly ok: false; readonly errors: readonly string[] };

// Non-link button styles only. Kept separate from ButtonStyle.Link/Premium so
// the APIButtonComponentWithCustomId style union (no Link, no Premium) is met
// without a cast — the Neon model never exposes Premium.
const CUSTOM_ID_BUTTON_STYLE_BY_NAME: Record<
  Exclude<TNeonDiscordButtonStyle, "link">,
  ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger
};

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function buildButton(
  button: INeonDiscordButton,
  rowIndex: number,
  buttonIndex: number,
  errors: string[]
): APIButtonComponent | undefined {
  const where = `row ${rowIndex} button ${buttonIndex}`;
  const before = errors.length;

  const label = button.label.trim();
  if (label.length === 0) {
    errors.push(`${where} requires a non-empty label`);
  } else if (label.length > NEON_DISCORD_COMPONENT_LIMITS.buttonLabel) {
    errors.push(`${where} label exceeds ${NEON_DISCORD_COMPONENT_LIMITS.buttonLabel} chars`);
  }

  const isLink = button.style === "link";
  if (isLink) {
    if (button.customId !== undefined) {
      errors.push(`${where} is a link button and must not carry a customId`);
    }
    if (button.url === undefined || !isHttpUrl(button.url)) {
      errors.push(`${where} link button requires an http(s) url`);
    }
  } else {
    if (button.url !== undefined) {
      errors.push(`${where} non-link button must not carry a url`);
    }
    if (button.customId === undefined || button.customId.trim().length === 0) {
      errors.push(`${where} non-link button requires a customId`);
    } else if (button.customId.length > NEON_DISCORD_COMPONENT_LIMITS.customId) {
      errors.push(`${where} customId exceeds ${NEON_DISCORD_COMPONENT_LIMITS.customId} chars`);
    }
  }

  if (errors.length > before) {
    return undefined;
  }

  const emoji = button.emoji !== undefined && button.emoji.length > 0 ? { name: button.emoji } : undefined;
  if (button.style === "link") {
    return {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      url: button.url as string,
      label,
      ...(emoji ? { emoji } : {}),
      ...(button.disabled !== undefined ? { disabled: button.disabled } : {})
    };
  }
  return {
    type: ComponentType.Button,
    style: CUSTOM_ID_BUTTON_STYLE_BY_NAME[button.style],
    custom_id: button.customId as string,
    label,
    ...(emoji ? { emoji } : {}),
    ...(button.disabled !== undefined ? { disabled: button.disabled } : {})
  };
}

function buildSelectOption(
  option: INeonDiscordSelectOption,
  rowIndex: number,
  optionIndex: number,
  errors: string[]
): APISelectMenuOption | undefined {
  const where = `row ${rowIndex} option ${optionIndex}`;
  const before = errors.length;

  const label = option.label.trim();
  const value = option.value.trim();
  if (label.length === 0 || value.length === 0) {
    errors.push(`${where} requires a non-empty label and value`);
  }
  if (label.length > NEON_DISCORD_COMPONENT_LIMITS.selectOptionLabel) {
    errors.push(`${where} label exceeds ${NEON_DISCORD_COMPONENT_LIMITS.selectOptionLabel} chars`);
  }
  if (value.length > NEON_DISCORD_COMPONENT_LIMITS.selectOptionValue) {
    errors.push(`${where} value exceeds ${NEON_DISCORD_COMPONENT_LIMITS.selectOptionValue} chars`);
  }
  if (
    option.description !== undefined &&
    option.description.length > NEON_DISCORD_COMPONENT_LIMITS.selectOptionDescription
  ) {
    errors.push(`${where} description exceeds ${NEON_DISCORD_COMPONENT_LIMITS.selectOptionDescription} chars`);
  }

  if (errors.length > before) {
    return undefined;
  }
  return {
    label,
    value,
    ...(option.description !== undefined ? { description: option.description } : {}),
    ...(option.default !== undefined ? { default: option.default } : {})
  };
}

function buildSelect(
  select: INeonDiscordSelect,
  rowIndex: number,
  errors: string[]
): APIStringSelectComponent | undefined {
  const where = `row ${rowIndex} select`;
  const before = errors.length;

  if (select.customId.trim().length === 0) {
    errors.push(`${where} requires a customId`);
  } else if (select.customId.length > NEON_DISCORD_COMPONENT_LIMITS.customId) {
    errors.push(`${where} customId exceeds ${NEON_DISCORD_COMPONENT_LIMITS.customId} chars`);
  }
  if (
    select.placeholder !== undefined &&
    select.placeholder.length > NEON_DISCORD_COMPONENT_LIMITS.selectPlaceholder
  ) {
    errors.push(`${where} placeholder exceeds ${NEON_DISCORD_COMPONENT_LIMITS.selectPlaceholder} chars`);
  }
  if (select.options.length === 0) {
    errors.push(`${where} requires at least one option`);
  } else if (select.options.length > NEON_DISCORD_COMPONENT_LIMITS.selectOptions) {
    errors.push(`${where} exceeds ${NEON_DISCORD_COMPONENT_LIMITS.selectOptions} options`);
  }

  const builtOptions: APISelectMenuOption[] = [];
  select.options.forEach((option, optionIndex) => {
    const result = buildSelectOption(option, rowIndex, optionIndex, errors);
    if (result) {
      builtOptions.push(result);
    }
  });

  // min/max selectable values: Discord allows min 0–25, max 1–25, and max must
  // not exceed the option count nor fall below min.
  const min = select.minValues;
  const max = select.maxValues;
  if (min !== undefined && (!Number.isInteger(min) || min < 0 || min > NEON_DISCORD_COMPONENT_LIMITS.selectValues)) {
    errors.push(`${where} minValues must be an integer 0–${NEON_DISCORD_COMPONENT_LIMITS.selectValues}`);
  }
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > NEON_DISCORD_COMPONENT_LIMITS.selectValues)) {
    errors.push(`${where} maxValues must be an integer 1–${NEON_DISCORD_COMPONENT_LIMITS.selectValues}`);
  }
  if (min !== undefined && max !== undefined && max < min) {
    errors.push(`${where} maxValues must be >= minValues`);
  }
  if (max !== undefined && select.options.length > 0 && max > select.options.length) {
    errors.push(`${where} maxValues cannot exceed the number of options`);
  }

  if (errors.length > before) {
    return undefined;
  }
  return {
    type: ComponentType.StringSelect,
    custom_id: select.customId,
    options: builtOptions,
    ...(select.placeholder !== undefined ? { placeholder: select.placeholder } : {}),
    ...(min !== undefined ? { min_values: min } : {}),
    ...(max !== undefined ? { max_values: max } : {}),
    ...(select.disabled !== undefined ? { disabled: select.disabled } : {})
  };
}

function buildRow(
  row: TNeonDiscordActionRow,
  rowIndex: number,
  errors: string[]
): APIActionRowComponent<APIComponentInMessageActionRow> | undefined {
  const before = errors.length;

  if ("buttons" in row) {
    if (row.buttons.length === 0) {
      errors.push(`row ${rowIndex} button row requires at least one button`);
      return undefined;
    }
    if (row.buttons.length > NEON_DISCORD_COMPONENT_LIMITS.buttonsPerRow) {
      errors.push(`row ${rowIndex} exceeds ${NEON_DISCORD_COMPONENT_LIMITS.buttonsPerRow} buttons`);
    }
    const built: APIButtonComponent[] = [];
    row.buttons.forEach((button, buttonIndex) => {
      const result = buildButton(button, rowIndex, buttonIndex, errors);
      if (result) {
        built.push(result);
      }
    });
    if (errors.length > before) {
      return undefined;
    }
    return { type: ComponentType.ActionRow, components: built };
  }

  const select = buildSelect(row.select, rowIndex, errors);
  if (!select || errors.length > before) {
    return undefined;
  }
  return { type: ComponentType.ActionRow, components: [select] };
}

/**
 * Validate + build a bounded set of Discord action rows. Returns every
 * validation error at once (not just the first) so an operator fixing a payload
 * sees the full picture. On any error the result is `ok: false` and the
 * transport stays suppressed.
 */
export function buildNeonDiscordComponentPayload(
  rows: readonly TNeonDiscordActionRow[]
): TNeonDiscordComponentBuildResult {
  const errors: string[] = [];

  if (rows.length === 0) {
    return { ok: false, errors: ["at least one action row is required"] };
  }
  if (rows.length > NEON_DISCORD_COMPONENT_LIMITS.rowsPerMessage) {
    errors.push(`a message carries at most ${NEON_DISCORD_COMPONENT_LIMITS.rowsPerMessage} action rows`);
  }

  const built: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  rows.forEach((row, rowIndex) => {
    const result = buildRow(row, rowIndex, errors);
    if (result) {
      built.push(result);
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, components: built };
}
