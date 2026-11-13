import type { TemplateContent, TemplatePurpose, TemplateVariable } from "./templates";

/*
 * Ready-made templates a business can start from. Written to pass review on the first try:
 * a clear reason for the message, details surrounded by words, a friendly close.
 * Pure data; import from "@relay/core/template-library".
 */

export type LibraryTemplate = {
  key: string;
  name: string;
  goal: "Bookings" | "Payments and orders" | "Keep in touch";
  /** One line shown on the card. */
  summary: string;
  purpose: TemplatePurpose;
  content: TemplateContent;
  variables: TemplateVariable[];
};

const v = (name: string, example: string): TemplateVariable => ({ name, example });

export const templateLibrary: LibraryTemplate[] = [
  {
    key: "appointment_reminder",
    name: "Appointment reminder",
    goal: "Bookings",
    summary: "Remind customers the day before, with a quick way to confirm.",
    purpose: "updates",
    content: {
      header: { kind: "text", text: "Appointment reminder" },
      body: "Hi {{customer_name}}, this is a reminder of your appointment on {{date}} at {{time}} at our {{branch}} branch. Reply below to confirm or let us know if you need another time.",
      footer: "Reply STOP to stop reminders",
      buttons: [
        { kind: "reply", text: "Confirm" },
        { kind: "reply", text: "Change time" },
      ],
    },
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
    goal: "Bookings",
    summary: "Confirm a new booking straight after it's made.",
    purpose: "updates",
    content: {
      header: null,
      body: "Thanks {{customer_name}}, your booking is confirmed for {{date}} at {{time}}. We look forward to seeing you. If anything changes, just reply to this message.",
      footer: null,
      buttons: [],
    },
    variables: [v("customer_name", "Sara"), v("date", "Saturday 16 November"), v("time", "10:30")],
  },
  {
    key: "follow_up_after_visit",
    name: "Thank you after a visit",
    goal: "Bookings",
    summary: "A warm thank-you the day after their visit.",
    purpose: "updates",
    content: {
      header: null,
      body: "Hi {{customer_name}}, thank you for visiting us today. We hope everything went well. If you have any questions about your treatment, reply here and our team will help.",
      footer: null,
      buttons: [],
    },
    variables: [v("customer_name", "Sara")],
  },
  {
    key: "payment_reminder",
    name: "Payment reminder",
    goal: "Payments and orders",
    summary: "A polite nudge for an open payment, with a link.",
    purpose: "updates",
    content: {
      header: null,
      body: "Hi {{customer_name}}, a friendly reminder that your payment of {{amount}} is due on {{date}}. You can pay securely using the button below. Thank you!",
      footer: null,
      buttons: [{ kind: "link", text: "Pay now", url: "https://pay.example.com" }],
    },
    variables: [v("customer_name", "Sara"), v("amount", "AED 350"), v("date", "20 November")],
  },
  {
    key: "payment_received",
    name: "Payment received",
    goal: "Payments and orders",
    summary: "Let customers know their payment arrived.",
    purpose: "updates",
    content: {
      header: null,
      body: "Thank you {{customer_name}}, we've received your payment of {{amount}}. Your receipt number is {{order_number}}. Have a great day!",
      footer: null,
      buttons: [],
    },
    variables: [v("customer_name", "Sara"), v("amount", "AED 350"), v("order_number", "#10482")],
  },
  {
    key: "order_on_its_way",
    name: "Order on its way",
    goal: "Payments and orders",
    summary: "Share that an order has left, with a tracking link.",
    purpose: "updates",
    content: {
      header: { kind: "text", text: "Your order is on its way" },
      body: "Good news {{customer_name}}! Your order {{order_number}} has left our store and should arrive by {{date}}. Track it any time with the button below.",
      footer: null,
      buttons: [{ kind: "link", text: "Track order", url: "https://track.example.com" }],
    },
    variables: [v("customer_name", "Sara"), v("order_number", "#10482"), v("date", "Tuesday 19 November")],
  },
  {
    key: "quote_sent",
    name: "Quote ready",
    goal: "Payments and orders",
    summary: "Tell a customer their quote is ready to review.",
    purpose: "updates",
    content: {
      header: null,
      body: "Hi {{customer_name}}, your quote for {{service}} is ready. The total comes to {{amount}}. Reply here with any questions, or tap below to accept it.",
      footer: null,
      buttons: [
        { kind: "reply", text: "Accept quote" },
        { kind: "reply", text: "I have a question" },
      ],
    },
    variables: [v("customer_name", "Sara"), v("service", "teeth whitening"), v("amount", "AED 1,200")],
  },
  {
    key: "feedback_request",
    name: "Ask for feedback",
    goal: "Keep in touch",
    summary: "Ask how it went, with one-tap answers.",
    purpose: "marketing",
    content: {
      header: null,
      body: "Hi {{customer_name}}, how was your visit to {{business_name}}? Your feedback helps us get better. Tap an option below; it only takes a second.",
      footer: null,
      buttons: [
        { kind: "reply", text: "It was great" },
        { kind: "reply", text: "Could be better" },
      ],
    },
    variables: [v("customer_name", "Sara"), v("business_name", "Lumen Clinics")],
  },
  {
    key: "we_miss_you",
    name: "We miss you",
    goal: "Keep in touch",
    summary: "Invite customers you haven't seen in a while back.",
    purpose: "marketing",
    content: {
      header: null,
      body: "Hi {{customer_name}}, it's been a while since your last visit and we'd love to see you again. Book this month and get {{offer}}. Reply here or tap below to book.",
      footer: "Reply STOP to stop offers",
      buttons: [{ kind: "reply", text: "Book a visit" }],
    },
    variables: [v("customer_name", "Sara"), v("offer", "15% off your next treatment")],
  },
  {
    key: "welcome",
    name: "Welcome",
    goal: "Keep in touch",
    summary: "Say hello to a new customer.",
    purpose: "marketing",
    content: {
      header: null,
      body: "Welcome to {{business_name}}, {{customer_name}}! We're happy to have you. Save this number: you can message us here any time for bookings and questions.",
      footer: null,
      buttons: [],
    },
    variables: [v("business_name", "Lumen Clinics"), v("customer_name", "Sara")],
  },
  {
    key: "holiday_hours",
    name: "Holiday opening hours",
    goal: "Keep in touch",
    summary: "Let customers know about changed opening hours.",
    purpose: "updates",
    content: {
      header: { kind: "text", text: "Holiday opening hours" },
      body: "Hi {{customer_name}}, a quick note that our opening hours change on {{date}}: we'll be open {{hours}}. Message us here if you'd like to book around it.",
      footer: null,
      buttons: [],
    },
    variables: [v("customer_name", "Sara"), v("date", "2 December"), v("hours", "from 10:00 to 16:00")],
  },
  {
    key: "back_in_stock",
    name: "Back in stock",
    goal: "Keep in touch",
    summary: "Tell customers a product they wanted is back.",
    purpose: "marketing",
    content: {
      header: null,
      body: "Good news {{customer_name}}, {{product}} is back in stock. We've kept a few aside for customers who asked. Reply here to reserve yours.",
      footer: "Reply STOP to stop offers",
      buttons: [{ kind: "reply", text: "Reserve one" }],
    },
    variables: [v("customer_name", "Sara"), v("product", "the whitening kit")],
  },
];
