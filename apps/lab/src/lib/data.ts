import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Camera,
  CircleAlert,
  Globe,
  HandHelping,
  Megaphone,
  MessageCircle,
  Sparkles,
  Users,
} from "lucide-react";

export type PageId = "home" | "inbox" | "customers" | "agents" | "campaigns" | "insights";

export const pages: { id: PageId; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: Sparkles },
  { id: "inbox", label: "Inbox", icon: MessageCircle },
  { id: "customers", label: "Customers", icon: Users },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "campaigns", label: "Campaigns", icon: Megaphone },
  { id: "insights", label: "Insights", icon: BarChart3 },
];

export type Channel = "WhatsApp" | "Instagram" | "Website";
export const channelIcon: Record<Channel, LucideIcon> = {
  WhatsApp: MessageCircle,
  Instagram: Camera,
  Website: Globe,
};

export type Handler = "Mira" | "Needs a person" | "Priya" | "Sameer";
export type Line = { by: "customer" | "mira" | "you" | "note"; text: string };

export type Chat = {
  id: string;
  name: string;
  preview: string;
  time: string;
  channel: Channel;
  who: Handler;
  unread: number;
  lines: Line[];
};

export const seedChats: Chat[] = [
  {
    id: "daniel",
    name: "Daniel Okafor",
    preview: "I was charged twice for the whitening. Can I get a refund?",
    time: "4 min",
    channel: "Instagram",
    who: "Needs a person",
    unread: 1,
    lines: [
      { by: "customer", text: "Hi, I had whitening done on Saturday." },
      { by: "mira", text: "Hi Daniel, thanks for coming in. How can I help?" },
      { by: "customer", text: "I was charged twice for the whitening. Can I get a refund?" },
      { by: "note", text: "Mira handed this chat to the Marina front desk. Refunds need a person." },
    ],
  },
  {
    id: "asha",
    name: "Asha Menon",
    preview: "Saturday 11 works. Do I need to bring my old reports?",
    time: "2 min",
    channel: "WhatsApp",
    who: "Mira",
    unread: 2,
    lines: [
      { by: "customer", text: "Hi, can I book a cleaning for this Saturday?" },
      { by: "mira", text: "Of course, Asha. Marina has 11:00 and 3:30 free on Saturday. Which suits you?" },
      { by: "customer", text: "Saturday 11 works. Do I need to bring my old reports?" },
      { by: "note", text: "Mira booked Saturday 11:00 with Dr. Rao" },
      {
        by: "mira",
        text: "You're booked for Saturday at 11:00 with Dr. Rao. Please bring any X-rays from the last two years.",
      },
    ],
  },
  {
    id: "rahul",
    name: "Rahul Verma",
    preview: "Can I move my appointment to Monday?",
    time: "2 hr",
    channel: "WhatsApp",
    who: "Mira",
    unread: 0,
    lines: [
      { by: "customer", text: "Can I move my appointment to Monday?" },
      { by: "mira", text: "Yes. Monday has 10:30 and 2:00 free. Which would you like?" },
    ],
  },
  {
    id: "visitor",
    name: "Website visitor",
    preview: "Do you open on Sundays?",
    time: "1 hr",
    channel: "Website",
    who: "Mira",
    unread: 0,
    lines: [
      { by: "customer", text: "Do you open on Sundays?" },
      { by: "mira", text: "I'm not sure about Sundays. Let me check with the team and get back to you." },
    ],
  },
  {
    id: "fatima",
    name: "Fatima Noor",
    preview: "You: Your invoice is attached. Thank you for visiting.",
    time: "32 min",
    channel: "WhatsApp",
    who: "Priya",
    unread: 0,
    lines: [
      { by: "customer", text: "Could you send me the invoice for today?" },
      { by: "you", text: "Your invoice is attached. Thank you for visiting." },
    ],
  },
  {
    id: "leila",
    name: "Leila Haddad",
    preview: "Thanks, see you tomorrow.",
    time: "3 hr",
    channel: "WhatsApp",
    who: "Sameer",
    unread: 0,
    lines: [
      { by: "you", text: "Your check-up is confirmed for Wednesday at 4:00." },
      { by: "customer", text: "Thanks, see you tomorrow." },
    ],
  },
  {
    id: "tom",
    name: "Tom Becker",
    preview: "How much is a check-up for a child?",
    time: "5 hr",
    channel: "Instagram",
    who: "Mira",
    unread: 0,
    lines: [
      { by: "customer", text: "How much is a check-up for a child?" },
      { by: "mira", text: "A child's check-up is AED 150. Would you like me to book one?" },
    ],
  },
];

export const draftReply =
  "Sorry about that, Daniel. I can see two charges of AED 450 on 9 Nov. I've refunded one; it reaches your card in 3 to 5 days.";

export type Need = {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  action: string;
  go: PageId;
};
export const seedNeeds: Need[] = [
  {
    id: "refund",
    icon: HandHelping,
    title: "Daniel is asking for a refund",
    detail: "Mira stopped and handed the chat to the front desk 4 minutes ago.",
    action: "Open chat",
    go: "inbox",
  },
  {
    id: "insurance",
    icon: BookOpen,
    title: "Mira couldn't answer an insurance question",
    detail: "“Do you take Aetna?” was asked 3 times this week.",
    action: "Teach Mira",
    go: "agents",
  },
  {
    id: "template",
    icon: CircleAlert,
    title: "WhatsApp rejected your reminder message",
    detail: "It reads like marketing. A small rewording fixes it.",
    action: "Fix message",
    go: "campaigns",
  },
];

export type Stage = "New enquiry" | "Talking" | "Booked" | "Visited";
export const customers: {
  name: string;
  branch: string;
  channel: Channel;
  stage: Stage;
  latest: string;
  who: string;
}[] = [
  {
    name: "Asha Menon",
    branch: "Marina",
    channel: "WhatsApp",
    stage: "Booked",
    latest: "Sat 11:00",
    who: "Mira",
  },
  {
    name: "Daniel Okafor",
    branch: "Marina",
    channel: "Instagram",
    stage: "Talking",
    latest: "Refund request",
    who: "Front desk",
  },
  {
    name: "Rahul Verma",
    branch: "Marina",
    channel: "WhatsApp",
    stage: "Booked",
    latest: "Mon 10:30",
    who: "Mira",
  },
  {
    name: "Fatima Noor",
    branch: "Downtown",
    channel: "WhatsApp",
    stage: "Visited",
    latest: "Invoice sent",
    who: "Priya",
  },
  {
    name: "Leila Haddad",
    branch: "Marina",
    channel: "WhatsApp",
    stage: "Booked",
    latest: "Wed 4:00",
    who: "Sameer",
  },
  {
    name: "Tom Becker",
    branch: "Downtown",
    channel: "Instagram",
    stage: "New enquiry",
    latest: "Asked a price",
    who: "Mira",
  },
  {
    name: "Nora Aziz",
    branch: "Marina",
    channel: "WhatsApp",
    stage: "New enquiry",
    latest: "Asked about braces",
    who: "Mira",
  },
  {
    name: "Omar Said",
    branch: "Downtown",
    channel: "WhatsApp",
    stage: "Booked",
    latest: "Thu 9:00",
    who: "Mira",
  },
  {
    name: "Ivy Chen",
    branch: "Marina",
    channel: "Website",
    stage: "Visited",
    latest: "Asked for a review",
    who: "Mira",
  },
];

export const campaigns = [
  {
    name: "Winter cleaning offer",
    status: "Draft",
    audience: 412,
    delivered: 0,
    read: 0,
    replied: 0,
    when: "Starts today 5:00 pm",
  },
  {
    name: "Winter check-up",
    status: "Sent",
    audience: 412,
    delivered: 94,
    read: 49,
    replied: 6,
    when: "4 Nov, 7 booked",
  },
  {
    name: "Diwali greetings",
    status: "Sent",
    audience: 1180,
    delivered: 97,
    read: 71,
    replied: 12,
    when: "30 Oct",
  },
  {
    name: "New Downtown branch",
    status: "Sending",
    audience: 640,
    delivered: 58,
    read: 22,
    replied: 3,
    when: "300 of 640 sent",
  },
] as const;

export const week = [
  { day: "Wed", mira: 31, team: 6 },
  { day: "Thu", mira: 38, team: 4 },
  { day: "Fri", mira: 12, team: 2 },
  { day: "Sat", mira: 52, team: 9 },
  { day: "Sun", mira: 44, team: 5 },
  { day: "Mon", mira: 40, team: 7 },
  { day: "Tue", mira: 42, team: 5 },
];
export const handovers = [
  { reason: "Refund or complaint", count: 14 },
  { reason: "Question she couldn't answer", count: 11 },
  { reason: "Customer asked for a person", count: 8 },
  { reason: "Medical advice", count: 5 },
];
export const todayStats = [
  { value: "47", label: "chats today", note: "Up 12% on last Tuesday" },
  { value: "89%", label: "answered by Mira", note: "5 went to your team" },
  { value: "1m 40s", label: "to first reply", note: "Target is under 5 minutes" },
  { value: "9", label: "appointments booked", note: "About AED 3,150" },
];
export const rightNow = [
  { name: "Asha Menon", what: "choosing a Saturday slot", channel: "WhatsApp" as Channel },
  { name: "Website visitor", what: "asking about Sunday hours", channel: "Website" as Channel },
  { name: "Rahul Verma", what: "moving an appointment", channel: "WhatsApp" as Channel },
];
export const suggestions = [
  "Offer 10% off cleanings to lapsed patients",
  "Why did Mira hand over 5 chats?",
  "Show this week's numbers",
];
export const recents = [
  "Winter cleaning offer",
  "Why did Mira hand over 5 chats?",
  "Add the Downtown branch",
  "Teach Mira the price list",
];
export const branches = ["Marina", "Downtown", "All branches"] as const;

export type AnswerKind = "campaign" | "numbers" | "handover";
export const answerKind = (q: string): AnswerKind =>
  /hand(ed)? ?over|why/i.test(q)
    ? "handover"
    : /number|week|report|how did/i.test(q)
      ? "numbers"
      : "campaign";
export const answers: Record<
  AnswerKind,
  { title: string; sub: string; icon: LucideIcon; before: string; after: string; actions: string[] }
> = {
  campaign: {
    title: "Winter cleaning offer",
    sub: "Campaign draft, 412 customers",
    icon: Megaphone,
    before:
      "I found 412 patients at Marina whose last visit was before 12 May. WhatsApp only allows approved messages for offers, so I reused “Seasonal offer”, which is already approved.",
    after:
      "Mira will handle the replies and book the slots. I've capped it at 100 messages a day so the front desk isn't swamped. Want it to start today at 5:00 pm?",
    actions: ["Yes, send at 5:00 pm", "Send me a test first", "Change the audience"],
  },
  numbers: {
    title: "This week at Marina",
    sub: "Report, last 7 days",
    icon: BarChart3,
    before: "Here's the week. Chats are up 12%, and Mira answered 87% of them without your team.",
    after: "Saturday was the busiest day. Want this sent to you every Monday morning?",
    actions: ["Yes, every Monday", "Compare with Downtown"],
  },
  handover: {
    title: "Why Mira handed chats over",
    sub: "38 chats, last 7 days",
    icon: HandHelping,
    before:
      "Mira handed 38 chats to your team this week. Most were refunds, which she isn't allowed to decide.",
    after:
      "Eleven were questions she couldn't answer. I can turn the three most common into answers for you to approve.",
    actions: ["Show me the three answers", "Let Mira approve small refunds"],
  },
};

export const handledToday: {
  name: string;
  outcome: "Booked" | "Answered" | "Handed over";
  detail: string;
  time: string;
}[] = [
  { name: "Omar Said", outcome: "Booked", detail: "Whitening, Thu 9:00", time: "11:42" },
  { name: "Nora Aziz", outcome: "Answered", detail: "Asked about braces", time: "11:20" },
  { name: "Ivy Chen", outcome: "Answered", detail: "Asked for directions", time: "10:58" },
  { name: "Leila Haddad", outcome: "Booked", detail: "Check-up, Wed 4:00", time: "10:31" },
  { name: "Karan Mehta", outcome: "Handed over", detail: "Asked for a person", time: "10:05" },
  { name: "Sara Lund", outcome: "Booked", detail: "Cleaning, Fri 2:00", time: "09:47" },
];
