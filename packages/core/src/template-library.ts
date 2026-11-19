import { authContent, type TemplateContent, type TemplatePurpose, type TemplateVariable } from "./templates";

/*
 * Ready-made templates a business can start from. Written to pass review on the first try:
 * a clear reason for the message, details surrounded by words, a friendly close.
 * Each entry lists the channels it suits; new channels add their own entries or reuse these.
 * Pure data; import from "@relay/core/template-library".
 */

export type LibraryTemplate = {
  key: string;
  name: string;
  /** A small grouping inside its category, e.g. "Bookings", "Payments". */
  topic: string;
  /** One line shown on the card. */
  summary: string;
  purpose: TemplatePurpose;
  /** Channel types this template suits. */
  channels: string[];
  content: TemplateContent;
  variables: TemplateVariable[];
};

const v = (name: string, example: string): TemplateVariable => ({ name, example });
const wa = ["whatsapp"];
const plain = (body: string, extra: Partial<TemplateContent> = {}): TemplateContent => ({
  header: null,
  body,
  footer: null,
  buttons: [],
  ...extra,
});

/* ------------------------------------------------------------------ utility */

const utility: LibraryTemplate[] = [
  {
    key: "online_booking_reminder",
    name: "Online booking reminder",
    topic: "Bookings",
    summary: "For online services: the day, time and the Google Meet link, with Confirm and Change.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, this is a reminder of your online {{service}} on {{date}} at {{time}}. Join here: {{meet_link}} Your booking reference is {{reference}}. Tap below to confirm, or to change it.",
      {
        header: { kind: "text", text: "Online booking reminder" },
        footer: "Reply STOP to stop reminders",
        buttons: [
          { kind: "reply", text: "Confirm" },
          { kind: "reply", text: "Change" },
        ],
      },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("service", "Consultation"),
      v("date", "Saturday 16 November"),
      v("time", "10:30 am"),
      v("meet_link", "https://meet.google.com/abc-defg-hij"),
      v("reference", "K7P2QD"),
    ],
  },
  {
    key: "booking_reminder",
    name: "Booking reminder",
    topic: "Bookings",
    summary: "Relay's booking reminders: the service, day, time and reference, with Confirm and Change.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, this is a reminder of your {{service}} on {{date}} at {{time}}. Your booking reference is {{reference}}. Tap below to confirm, or to change it.",
      {
        header: { kind: "text", text: "Booking reminder" },
        footer: "Reply STOP to stop reminders",
        buttons: [
          { kind: "reply", text: "Confirm" },
          { kind: "reply", text: "Change" },
        ],
      },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("service", "Haircut"),
      v("date", "Saturday 16 November"),
      v("time", "10:30 am"),
      v("reference", "K7P2QD"),
    ],
  },
  {
    key: "appointment_reminder",
    name: "Appointment reminder",
    topic: "Bookings",
    summary: "Remind customers the day before, with a quick way to confirm.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, this is a reminder of your appointment on {{date}} at {{time}} at our {{branch}} branch. Reply below to confirm or let us know if you need another time.",
      {
        header: { kind: "text", text: "Appointment reminder" },
        footer: "Reply STOP to stop reminders",
        buttons: [
          { kind: "reply", text: "Confirm" },
          { kind: "reply", text: "Change time" },
        ],
      },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("date", "Saturday 16 November"),
      v("time", "10:30"),
      v("branch", "Marina"),
    ],
  },
  {
    key: "booking_confirmed",
    name: "Booking confirmed",
    topic: "Bookings",
    summary: "Confirm a new booking straight after it's made.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Thanks {{customer_name}}, your booking is confirmed for {{date}} at {{time}}. We look forward to seeing you. If anything changes, just reply to this message.",
    ),
    variables: [v("customer_name", "Sara"), v("date", "Saturday 16 November"), v("time", "10:30")],
  },
  {
    key: "booking_cancelled",
    name: "Booking cancelled",
    topic: "Bookings",
    summary: "Let customers know a booking was cancelled, with a way to rebook.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, your booking on {{date}} at {{time}} has been cancelled as requested. Whenever you're ready, tap below and we'll find you a new time.",
      { buttons: [{ kind: "reply", text: "Book again" }] },
    ),
    variables: [v("customer_name", "Sara"), v("date", "Saturday 16 November"), v("time", "10:30")],
  },
  {
    key: "follow_up_after_visit",
    name: "Thank you after a visit",
    topic: "Bookings",
    summary: "A warm thank-you the day after their visit.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, thank you for visiting us today. We hope everything went well. If you have any questions about your treatment, reply here and our team will help.",
    ),
    variables: [v("customer_name", "Sara")],
  },
  {
    key: "payment_reminder",
    name: "Payment reminder",
    topic: "Payments",
    summary: "A polite nudge for an open payment, with a link.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, a friendly reminder that your payment of {{amount}} is due on {{date}}. You can pay securely using the button below. Thank you!",
      { buttons: [{ kind: "link", text: "Pay now", url: "https://pay.example.com" }] },
    ),
    variables: [v("customer_name", "Sara"), v("amount", "AED 350"), v("date", "20 November")],
  },
  {
    key: "payment_received",
    name: "Payment received",
    topic: "Payments",
    summary: "Let customers know their payment arrived.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Thank you {{customer_name}}, we've received your payment of {{amount}}. Your receipt number is {{order_number}}. Have a great day!",
    ),
    variables: [v("customer_name", "Sara"), v("amount", "AED 350"), v("order_number", "#10482")],
  },
  {
    key: "order_confirmed",
    name: "Order confirmed",
    topic: "Orders",
    summary: "Confirm an order and what happens next.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Thanks for your order, {{customer_name}}! Order {{order_number}} for {{amount}} is confirmed. We'll message you here as soon as it's on its way.",
      { header: { kind: "text", text: "Order confirmed" } },
    ),
    variables: [v("customer_name", "Sara"), v("order_number", "#10482"), v("amount", "AED 240")],
  },
  {
    key: "order_on_its_way",
    name: "Order on its way",
    topic: "Orders",
    summary: "Share that an order has left, with a tracking link.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Good news {{customer_name}}! Your order {{order_number}} has left our store and should arrive by {{date}}. Track it any time with the button below.",
      {
        header: { kind: "text", text: "Your order is on its way" },
        buttons: [{ kind: "link", text: "Track order", url: "https://track.example.com" }],
      },
    ),
    variables: [v("customer_name", "Sara"), v("order_number", "#10482"), v("date", "Tuesday 19 November")],
  },
  {
    key: "ready_for_pickup",
    name: "Ready for pickup",
    topic: "Orders",
    summary: "Tell customers their order is ready to collect.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, your order {{order_number}} is ready for pickup at our {{branch}} branch. We're open until {{time}} today. See you soon!",
      { buttons: [{ kind: "call", text: "Call the store", phone: "+971 4 123 4567" }] },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("order_number", "#10482"),
      v("branch", "Marina"),
      v("time", "21:00"),
    ],
  },
  {
    key: "quote_sent",
    name: "Quote ready",
    topic: "Payments",
    summary: "Tell a customer their quote is ready to review.",
    purpose: "updates",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, your quote for {{service}} is ready. The total comes to {{amount}}. Reply here with any questions, or tap below to accept it.",
      {
        buttons: [
          { kind: "reply", text: "Accept quote" },
          { kind: "reply", text: "I have a question" },
        ],
      },
    ),
    variables: [v("customer_name", "Sara"), v("service", "teeth whitening"), v("amount", "AED 1,200")],
  },
];

/* ---------------------------------------------------------------- marketing */

const marketing: LibraryTemplate[] = [
  {
    key: "welcome",
    name: "Welcome",
    topic: "Relationships",
    summary: "Say hello to a new customer.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Welcome to {{business_name}}, {{customer_name}}! We're happy to have you. Save this number: you can message us here any time for bookings and questions.",
    ),
    variables: [v("business_name", "Lumen Clinics"), v("customer_name", "Sara")],
  },
  {
    key: "we_miss_you",
    name: "We miss you",
    topic: "Win back",
    summary: "Invite customers you haven't seen in a while back.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, it's been a while since your last visit and we'd love to see you again. Book this month and get {{offer}}. Reply here or tap below to book.",
      { footer: "Reply STOP to stop offers", buttons: [{ kind: "reply", text: "Book a visit" }] },
    ),
    variables: [v("customer_name", "Sara"), v("offer", "15% off your next treatment")],
  },
  {
    key: "seasonal_offer",
    name: "Seasonal offer",
    topic: "Offers",
    summary: "Announce a limited-time offer with an end date.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, our {{season}} offer is here: {{offer}} until {{date}}. Spaces fill up quickly, so tap below to grab yours.",
      {
        header: { kind: "text", text: "A little something for you" },
        footer: "Reply STOP to stop offers",
        buttons: [{ kind: "reply", text: "Book now" }],
      },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("season", "winter"),
      v("offer", "20% off whitening"),
      v("date", "31 December"),
    ],
  },
  {
    key: "birthday_greeting",
    name: "Birthday treat",
    topic: "Relationships",
    summary: "Celebrate a customer's birthday with a small gift.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Happy birthday, {{customer_name}}! To celebrate, here's {{offer}} on your next visit, valid all month. We hope your year is a great one.",
      { footer: "Reply STOP to stop offers", buttons: [{ kind: "reply", text: "Use my gift" }] },
    ),
    variables: [v("customer_name", "Sara"), v("offer", "a free polish")],
  },
  {
    key: "new_service",
    name: "New service",
    topic: "News",
    summary: "Tell customers about something new you offer.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, we've just started offering {{service}} at {{business_name}}. Would you like to know more or book a first session? Tap below.",
      {
        buttons: [
          { kind: "reply", text: "Tell me more" },
          { kind: "reply", text: "Book a session" },
        ],
      },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("service", "invisible braces"),
      v("business_name", "Lumen Clinics"),
    ],
  },
  {
    key: "event_invitation",
    name: "Event invitation",
    topic: "News",
    summary: "Invite customers to an open day or event.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, you're invited to our {{event}} on {{date}} at {{time}} at the {{branch}} branch. Join us for free checks and refreshments. Tap below to save your spot.",
      { footer: "Reply STOP to stop invitations", buttons: [{ kind: "reply", text: "Count me in" }] },
    ),
    variables: [
      v("customer_name", "Sara"),
      v("event", "open day"),
      v("date", "Saturday 23 November"),
      v("time", "11:00"),
      v("branch", "Marina"),
    ],
  },
  {
    key: "feedback_request",
    name: "Ask for feedback",
    topic: "Relationships",
    summary: "Ask how it went, with one-tap answers.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, how was your visit to {{business_name}}? Your feedback helps us get better. Tap an option below; it only takes a second.",
      {
        buttons: [
          { kind: "reply", text: "It was great" },
          { kind: "reply", text: "Could be better" },
        ],
      },
    ),
    variables: [v("customer_name", "Sara"), v("business_name", "Lumen Clinics")],
  },
  {
    key: "review_request",
    name: "Ask for a review",
    topic: "Relationships",
    summary: "Ask happy customers for a public review.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Thanks again for choosing {{business_name}}, {{customer_name}}. If you enjoyed your visit, a quick review would mean a lot to our team. It takes less than a minute.",
      { buttons: [{ kind: "link", text: "Leave a review", url: "https://g.page/r/example" }] },
    ),
    variables: [v("business_name", "Lumen Clinics"), v("customer_name", "Sara")],
  },
  {
    key: "back_in_stock",
    name: "Back in stock",
    topic: "Offers",
    summary: "Tell customers a product they wanted is back.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Good news {{customer_name}}, {{product}} is back in stock. We've kept a few aside for customers who asked. Reply here to reserve yours.",
      { footer: "Reply STOP to stop offers", buttons: [{ kind: "reply", text: "Reserve one" }] },
    ),
    variables: [v("customer_name", "Sara"), v("product", "the whitening kit")],
  },
  {
    key: "holiday_hours",
    name: "Holiday opening hours",
    topic: "News",
    summary: "Let customers know about changed opening hours.",
    purpose: "marketing",
    channels: wa,
    content: plain(
      "Hi {{customer_name}}, a quick note that our opening hours change on {{date}}: we'll be open {{hours}}. Message us here if you'd like to book around it.",
      { header: { kind: "text", text: "Holiday opening hours" } },
    ),
    variables: [v("customer_name", "Sara"), v("date", "2 December"), v("hours", "from 10:00 to 16:00")],
  },
];

/* ----------------------------------------------------------- authentication */

const auth = (
  key: string,
  name: string,
  topic: string,
  summary: string,
  settings: Parameters<typeof authContent>[0],
): LibraryTemplate => ({
  key,
  name,
  topic,
  summary,
  purpose: "login",
  channels: wa,
  content: authContent(settings),
  variables: [v("code", "482913")],
});

const authentication: LibraryTemplate[] = [
  auth(
    "login_code",
    "Login code",
    "Sign in",
    "A code to sign in, with a security note and a 10-minute expiry.",
    {
      securityNote: true,
      expiresInMinutes: 10,
      buttonText: "Copy code",
    },
  ),
  auth("sign_up_code", "Sign-up verification", "Sign up", "Confirm a new account's phone number.", {
    securityNote: true,
    expiresInMinutes: 15,
    buttonText: "Copy code",
  }),
  auth("password_reset_code", "Password reset", "Account", "A code to reset a password; expires fast.", {
    securityNote: true,
    expiresInMinutes: 5,
    buttonText: "Copy code",
  }),
  auth(
    "payment_confirmation_code",
    "Payment confirmation",
    "Payments",
    "Confirm a payment before it goes through.",
    {
      securityNote: true,
      expiresInMinutes: 5,
      buttonText: "Copy code",
    },
  ),
  auth(
    "booking_verification_code",
    "Booking verification",
    "Bookings",
    "Check it's really them before confirming a booking.",
    {
      securityNote: false,
      expiresInMinutes: 30,
      buttonText: "Copy code",
    },
  ),
  auth("simple_code", "Simple code", "Any", "Just the code and a copy button, no extras.", {
    securityNote: false,
    expiresInMinutes: null,
    buttonText: "Copy code",
  }),
];

export const templateLibrary: LibraryTemplate[] = [...utility, ...marketing, ...authentication];
