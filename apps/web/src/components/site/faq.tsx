import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@relay/ui/ui/accordion";

const questions: { q: string; a: string }[] = [
  {
    q: "Do I need a new phone number?",
    a: "No. You can connect the WhatsApp Business number you already use, or a new one. A number can be on the WhatsApp Business app and the platform at the same time, so your phone keeps working.",
  },
  {
    q: "Is this the official WhatsApp?",
    a: "Yes. Relay sends and receives messages through Meta's official WhatsApp Business Platform. Templates are approved by Meta, and you stay within WhatsApp's rules.",
  },
  {
    q: "What does Mira do on her own?",
    a: "Only what you allow. She answers from the information you give her, can book appointments, and hands a chat to your team with a summary when she isn't sure or the customer asks for a person.",
  },
  {
    q: "Can my team take over a chat?",
    a: "Any time. Assign a chat to yourself or a teammate and Mira steps back. You can also turn her off for a branch or a single customer.",
  },
  {
    q: "What does it cost?",
    a: "Relay is free while it's in early access. Meta charges for some WhatsApp messages, such as marketing templates, at their published rates.",
  },
];

/** Short answers to what businesses ask before signing up. */
export function Faq() {
  return (
    <section
      id="faq"
      className="mx-auto grid max-w-[1200px] scroll-mt-24 gap-10 px-4 pb-24 sm:px-6 md:pb-32 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]"
    >
      <div className="flex flex-col gap-3">
        <span className="text-[13px] font-medium tracking-[0.02em] text-[#b39bff]">FAQ</span>
        <h2 className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] sm:text-[36px] sm:leading-[42px]">
          Questions businesses ask first.
        </h2>
      </div>
      <Accordion type="single" collapsible className="border-t border-white/10">
        {questions.map((item) => (
          <AccordionItem key={item.q} value={item.q} className="border-white/10">
            <AccordionTrigger className="py-5 text-[16px] text-white hover:no-underline [&>svg]:text-white/60">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-[15px] leading-6 text-white/70">{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
