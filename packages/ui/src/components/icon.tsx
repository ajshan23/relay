"use client";

import { cva } from "class-variance-authority";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Building2,
  Calendar,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Clock,
  Copy,
  CornerDownRight,
  Download,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Globe,
  HandHelping,
  History,
  House,
  Image,
  Inbox,
  Info,
  Lightbulb,
  Link,
  ListFilter,
  LoaderCircle,
  Lock,
  LogOut,
  type LucideIcon,
  Mail,
  MapPin,
  Megaphone,
  Menu,
  MessageCircle,
  MessagesSquare,
  Mic,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Smile,
  Sparkles,
  SquarePen,
  Star,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  UserPlus,
  Users,
  Video,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * Every icon the product uses, by meaning rather than by drawing.
 * Pages pick `name="campaigns"`, never a lucide component, so a drawing can be swapped in one place.
 */
export const icons = {
  // Navigation and pages
  home: House,
  inbox: Inbox,
  conversations: MessagesSquare,
  message: MessageCircle,
  customers: Users,
  agent: Bot,
  campaigns: Megaphone,
  insights: BarChart3,
  settings: Settings,
  knowledge: BookOpen,
  automation: Workflow,
  integrations: Plug,
  history: History,
  notifications: Bell,
  menu: Menu,

  // Actions
  search: Search,
  add: Plus,
  edit: Pencil,
  compose: SquarePen,
  delete: Trash2,
  close: X,
  check: Check,
  checkDouble: CheckCheck,
  location: MapPin,
  video: Video,
  blocked: CircleSlash,
  more: Ellipsis,
  moreVertical: EllipsisVertical,
  filter: ListFilter,
  sort: ArrowUpDown,
  display: SlidersHorizontal,
  attach: Paperclip,
  send: Send,
  upload: Upload,
  download: Download,
  link: Link,
  copy: Copy,
  external: ExternalLink,
  refresh: RefreshCw,
  archive: Archive,
  play: Play,
  pause: Pause,
  signOut: LogOut,
  addUser: UserPlus,
  reply: CornerDownRight,
  handoff: HandHelping,

  // Direction
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronUp: ChevronUp,
  chevronsLeft: ChevronsLeft,
  chevronsRight: ChevronsRight,
  chevronsUpDown: ChevronsUpDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,

  // AI
  sparkles: Sparkles,
  idea: Lightbulb,

  // Business and channels
  branch: MapPin,
  business: Building2,
  whatsapp: MessageCircle,
  instagram: Camera,
  website: Globe,
  phone: Phone,
  mail: Mail,
  tag: Tag,

  // Time
  calendar: Calendar,
  clock: Clock,

  // Status and feedback
  alert: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  help: CircleHelp,
  success: CircleCheck,
  pending: CircleDashed,
  loading: LoaderCircle,
  star: Star,
  lock: Lock,
  zap: Zap,

  // People
  user: User,
  users: Users,

  // Content
  file: FileText,
  image: Image,
  emoji: Smile,
  mic: Mic,
  palette: Palette,
  /** A fork in an automation. Not a business branch: that is `branch`. */
  split: GitBranch,

  // View
  eye: Eye,
  eyeOff: EyeOff,
  panelOpen: PanelRightOpen,
  panelClose: PanelRightClose,
  sidebarOpen: PanelLeftOpen,
  sidebarClose: PanelLeftClose,
  sun: Sun,
  moon: Moon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

const iconSizes = cva("shrink-0", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
  defaultVariants: { size: "md" },
});

export type IconSize = "xs" | "sm" | "md" | "lg";

export type IconProps = {
  name: IconName;
  /** xs 12px, sm 14px, md 16px (default), lg 20px. */
  size?: IconSize;
  className?: string;
  /** Read out by screen readers. Leave empty when the icon sits next to text that says the same thing. */
  label?: string;
};

/**
 * The only way pages draw an icon. Decorative by default (aria-hidden);
 * pass `label` when the icon carries meaning on its own.
 */
export function Icon({ name, size = "md", className, label }: IconProps) {
  const Drawing = icons[name];
  return (
    <Drawing
      className={cn(iconSizes({ size }), name === "loading" && "motion-safe:animate-spin", className)}
      strokeWidth={1.75}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}

const iconButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
        outline:
          "border border-input bg-background text-foreground hover:bg-muted aria-expanded:bg-muted aria-pressed:bg-muted",
        solid: "bg-primary text-primary-foreground hover:bg-primary/90",
      },
      size: {
        sm: "size-7",
        md: "size-8",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export type IconButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  icon: IconName;
  /** Required. Used as the accessible name and shown in the tooltip. Say what it does: "Filter", "Close panel". */
  label: string;
  /** sm 28px with a 14px icon, md 32px with a 16px icon (default). */
  size?: "sm" | "md";
  variant?: "ghost" | "outline" | "solid";
  tooltipSide?: "top" | "right" | "bottom" | "left";
};

/**
 * An icon-only button. Use it for toolbar and row actions where a word would not fit;
 * the label is always available as the accessible name and as a tooltip.
 */
export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  tooltipSide,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type={type}
          aria-label={label}
          data-slot="icon-button"
          className={cn(iconButtonVariants({ variant, size }), className)}
          {...props}
        >
          <Icon name={icon} size={size === "sm" ? "sm" : "md"} />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
