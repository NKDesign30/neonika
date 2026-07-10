/**
 * Pure, side-effect-free builder + validator for Discord slash-command (chat
 * input) definitions to be bulk-registered for a guild. Mirrors the other
 * discord*Payload builders: it validates a leak-safe Neon command model against
 * Discord's documented limits up front so the gated deploy transport never hands
 * discord.js a command set the API would reject.
 *
 * Scope is the command definition only (name + description). Command options,
 * subcommands and localizations are a separate, larger block. No client, no
 * token here — the gated deploy transport (the only live-side-effect site)
 * consumes the validated output.
 */

// Discord application-command hard limits (stable platform constants).
export const NEON_DISCORD_SLASH_LIMITS = {
  commandName: 32,
  commandDescription: 100,
  optionName: 32,
  optionDescription: 100,
  maxOptions: 25,
  maxCommands: 100
} as const;

// Chat-input command names: 1–32 chars, letters/numbers/dash/underscore, and
// must be lowercase. Unicode letters/numbers are allowed by Discord.
const COMMAND_NAME_SHAPE = /^[-_\p{L}\p{N}]+$/u;

export interface INeonSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly INeonSlashCommandOption[];
}

export interface INeonSlashCommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: "string";
  readonly required?: boolean;
}

export interface INeonValidatedSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly INeonValidatedSlashCommandOption[];
}

export interface INeonValidatedSlashCommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: 3;
  readonly required: boolean;
}

export type TNeonSlashCommandBuildResult =
  | { readonly ok: true; readonly commands: readonly INeonValidatedSlashCommand[] }
  | { readonly ok: false; readonly errors: readonly string[] };

function validateCommand(command: INeonSlashCommand, index: number, errors: string[]): INeonValidatedSlashCommand | undefined {
  const where = `command ${index}`;
  const before = errors.length;

  const name = command.name;
  if (name.length === 0 || name.length > NEON_DISCORD_SLASH_LIMITS.commandName) {
    errors.push(`${where} name must be 1–${NEON_DISCORD_SLASH_LIMITS.commandName} chars`);
  } else {
    if (name !== name.toLowerCase()) {
      errors.push(`${where} name "${name}" must be lowercase`);
    }
    if (!COMMAND_NAME_SHAPE.test(name)) {
      errors.push(`${where} name "${name}" may only contain letters, numbers, '-' and '_'`);
    }
  }

  const description = command.description.trim();
  if (description.length === 0 || description.length > NEON_DISCORD_SLASH_LIMITS.commandDescription) {
    errors.push(`${where} description must be 1–${NEON_DISCORD_SLASH_LIMITS.commandDescription} chars`);
  }

  const options = validateOptions(command.options ?? [], where, errors);

  if (errors.length > before) {
    return undefined;
  }
  return {
    name,
    description,
    ...(options.length > 0 ? { options } : {})
  };
}

function validateOptions(
  options: readonly INeonSlashCommandOption[],
  where: string,
  errors: string[]
): readonly INeonValidatedSlashCommandOption[] {
  if (options.length > NEON_DISCORD_SLASH_LIMITS.maxOptions) {
    errors.push(`${where} carries at most ${NEON_DISCORD_SLASH_LIMITS.maxOptions} options`);
  }

  const built: INeonValidatedSlashCommandOption[] = [];
  const seenNames = new Set<string>();
  options.forEach((option, index) => {
    const optionWhere = `${where} option ${index}`;
    const before = errors.length;
    const name = option.name;
    if (name.length === 0 || name.length > NEON_DISCORD_SLASH_LIMITS.optionName) {
      errors.push(`${optionWhere} name must be 1–${NEON_DISCORD_SLASH_LIMITS.optionName} chars`);
    } else {
      if (name !== name.toLowerCase()) {
        errors.push(`${optionWhere} name "${name}" must be lowercase`);
      }
      if (!COMMAND_NAME_SHAPE.test(name)) {
        errors.push(`${optionWhere} name "${name}" may only contain letters, numbers, '-' and '_'`);
      }
      if (seenNames.has(name)) {
        errors.push(`${optionWhere} name "${name}" is a duplicate`);
      }
    }

    const description = option.description.trim();
    if (description.length === 0 || description.length > NEON_DISCORD_SLASH_LIMITS.optionDescription) {
      errors.push(`${optionWhere} description must be 1–${NEON_DISCORD_SLASH_LIMITS.optionDescription} chars`);
    }

    if (option.type !== "string") {
      errors.push(`${optionWhere} type "${option.type}" is not supported`);
    }

    if (errors.length === before) {
      seenNames.add(name);
      built.push({
        name,
        description,
        type: 3,
        required: option.required === true
      });
    }
  });

  return built;
}

/**
 * Validate + build a bounded set of slash commands. Returns every validation
 * error at once, and rejects duplicate names (Discord refuses a command set with
 * a repeated name). On any error the result is `ok: false` and the deploy
 * transport stays suppressed.
 */
export function buildNeonSlashCommandPayload(
  commands: readonly INeonSlashCommand[]
): TNeonSlashCommandBuildResult {
  const errors: string[] = [];

  if (commands.length === 0) {
    return { ok: false, errors: ["at least one command is required"] };
  }
  if (commands.length > NEON_DISCORD_SLASH_LIMITS.maxCommands) {
    errors.push(`a guild carries at most ${NEON_DISCORD_SLASH_LIMITS.maxCommands} commands`);
  }

  const built: INeonValidatedSlashCommand[] = [];
  const seenNames = new Set<string>();
  commands.forEach((command, index) => {
    const result = validateCommand(command, index, errors);
    if (result) {
      if (seenNames.has(result.name)) {
        errors.push(`command ${index} name "${result.name}" is a duplicate`);
      } else {
        seenNames.add(result.name);
        built.push(result);
      }
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, commands: built };
}

const WORKBOARD_TASK_OPTION: INeonSlashCommandOption = {
  name: "task",
  description: "Task text for the Workboard card",
  type: "string",
  required: true
};

export function createNeonDiscordOperatorSlashCommands(): readonly INeonSlashCommand[] {
  return [
    {
      name: "workboard",
      description: "Create a Neon Workboard card",
      options: [WORKBOARD_TASK_OPTION]
    },
    {
      name: "task",
      description: "Create a Neon task card",
      options: [WORKBOARD_TASK_OPTION]
    },
    {
      name: "todo",
      description: "Create a Neon todo card",
      options: [WORKBOARD_TASK_OPTION]
    },
    {
      name: "neon-canary-ping",
      description: "Neon canary liveness check"
    }
  ];
}
