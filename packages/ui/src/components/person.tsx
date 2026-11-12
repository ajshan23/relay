"use client";

import { cn } from "../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Icon, type IconName } from "./icon";

export type PersonSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Maps our size names onto the avatar primitive (xs 20, sm 24, md 32, lg 40, xl 56px). */
const avatarSize = {
  xs: "xs",
  sm: "sm",
  md: "default",
  lg: "lg",
  xl: "xl",
} as const satisfies Record<PersonSize, string>;

/** Up to two initials from a name: "Priya Shah" gives "PS", "+91 98450" gives "9". */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return (
    letters
      .map((w) => (w ? Array.from(w)[0] : ""))
      .join("")
      .toUpperCase() || "?"
  );
}

export type PersonProps = {
  name: string;
  /** Photo URL. Falls back to initials while loading or when it fails. */
  src?: string;
  size?: PersonSize;
  /** Hide from screen readers when the name is already written next to the avatar. */
  decorative?: boolean;
  className?: string;
};

/**
 * A human: a customer or a team member. Shows a photo when there is one, otherwise initials.
 * For the AI agent use `AgentAvatar`, never this.
 */
export function Person({ name, src, size = "md", decorative = false, className }: PersonProps) {
  return (
    <Avatar
      size={avatarSize[size]}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      className={className}
    >
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback aria-hidden>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

const agentSize: Record<PersonSize, { box: string; text: string; icon: "xs" | "sm" | "md" | "lg" }> = {
  xs: { box: "size-5 rounded-sm", text: "text-[10px]", icon: "xs" },
  sm: { box: "size-6 rounded-md", text: "text-[11px]", icon: "xs" },
  md: { box: "size-8 rounded-md", text: "text-sm", icon: "md" },
  lg: { box: "size-10 rounded-lg", text: "text-base", icon: "lg" },
  xl: { box: "size-14 rounded-xl", text: "text-xl", icon: "lg" },
};

export type AgentAvatarProps = {
  /** The agent's name, for example "Mira". Used as the accessible name and for the default letter. */
  name: string;
  /** Show this icon instead of a letter, for example "agent" or "sparkles". */
  icon?: IconName;
  /** Override the letter. Defaults to the first letter of the name. */
  letter?: string;
  size?: PersonSize;
  decorative?: boolean;
  className?: string;
};

/**
 * The AI agent's mark: a solid AI-violet tile with a letter or an icon. Never a human face.
 * Use it wherever the agent speaks or acts, so people can always tell the AI from a person.
 */
export function AgentAvatar({
  name,
  icon,
  letter,
  size = "md",
  decorative = false,
  className,
}: AgentAvatarProps) {
  const s = agentSize[size];
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": `${name}, AI agent` };
  return (
    <span
      {...a11y}
      data-slot="agent-avatar"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-ai-strong font-bold text-ai-strong-foreground select-none",
        s.box,
        s.text,
        className,
      )}
    >
      {icon ? <Icon name={icon} size={s.icon} /> : (letter ?? initials(name).slice(0, 1))}
    </span>
  );
}

const overflowSize: Record<"xs" | "sm" | "md", string> = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
};

export type PersonStackProps = {
  people: { name: string; src?: string }[];
  /** How many avatars to show before "+n". Default 3. */
  max?: number;
  size?: "xs" | "sm" | "md";
  className?: string;
};

/**
 * A few overlapping avatars with a "+n" for the rest. Use it for who is on a conversation
 * or a team; the full list of names is the accessible name.
 */
export function PersonStack({ people, max = 3, size = "sm", className }: PersonStackProps) {
  const shown = people.slice(0, Math.max(0, max));
  const rest = people.length - shown.length;
  return (
    <div
      role="img"
      aria-label={people.map((p) => p.name).join(", ")}
      className={cn("flex items-center -space-x-1.5", className)}
    >
      {shown.map((p, i) => (
        <Person
          // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat and order is stable
          key={`${p.name}-${i}`}
          name={p.name}
          src={p.src}
          size={size}
          decorative
          className="ring-2 ring-background"
        />
      ))}
      {rest > 0 ? (
        <span
          aria-hidden
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ring-2 ring-background",
            overflowSize[size],
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
