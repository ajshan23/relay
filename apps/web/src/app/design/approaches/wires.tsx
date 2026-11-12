import type { ReactNode } from "react";

/*
 * Low-fidelity wireframes: grey blocks only, so the comparison is about structure, not styling.
 * The amber block in each one marks where the eye lands first.
 */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden
      className="flex aspect-[16/10] w-full gap-1.5 overflow-hidden rounded-lg border bg-neutral-100 p-1.5 text-[9px] leading-tight text-neutral-500 dark:bg-neutral-900"
    >
      {children}
    </div>
  );
}

function Block({
  label,
  className = "",
  focus,
  children,
}: {
  label?: string;
  className?: string;
  focus?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col gap-1 rounded-[5px] p-1.5 ${
        focus ? "bg-amber-300 text-amber-950" : "bg-white dark:bg-neutral-800"
      } ${className}`}
    >
      {label ? <span className="font-semibold">{label}</span> : null}
      {children}
    </div>
  );
}

function Lines({ n, focusFirst }: { n: number; focusFirst?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: n }, (_, i) => `line-${i}`).map((key, i) => (
        <span
          key={key}
          className={`h-1.5 rounded-full ${
            focusFirst && i === 0 ? "bg-amber-300" : "bg-neutral-200 dark:bg-neutral-700"
          }`}
          style={{ width: `${90 - ((i * 17) % 40)}%` }}
        />
      ))}
    </div>
  );
}

function Rail() {
  return (
    <div className="flex w-[5%] shrink-0 flex-col items-center gap-1 rounded-[5px] bg-neutral-300 py-1.5 dark:bg-neutral-700">
      {["a", "b", "c", "d", "e"].map((k) => (
        <span key={k} className="size-[7px] rounded-sm bg-neutral-400 dark:bg-neutral-500" />
      ))}
    </div>
  );
}

export function WireConsole() {
  return (
    <Frame>
      <Rail />
      <Block label="Chats" className="w-[24%]" focus>
        <Lines n={6} />
      </Block>
      <Block label="Conversation" className="flex-1">
        <Lines n={5} />
        <span className="mt-auto h-3 rounded bg-neutral-200 dark:bg-neutral-700" />
      </Block>
      <Block label="Customer" className="w-[20%]">
        <Lines n={4} />
      </Block>
    </Frame>
  );
}

export function WireAgentFirst() {
  return (
    <Frame>
      <Rail />
      <Block className="flex-1 items-center justify-center">
        <div className="flex w-[58%] flex-col items-center gap-1.5">
          <span className="size-4 rounded-md bg-amber-300" />
          <span className="font-semibold">What's next for your agent?</span>
          <Block label="Ask or instruct" className="w-full border border-amber-300" />
          <Block label="Needs you" className="w-full bg-neutral-100 dark:bg-neutral-900">
            <Lines n={3} />
          </Block>
        </div>
      </Block>
    </Frame>
  );
}

export function WireChatApp() {
  return (
    <Frame>
      <Block label="Chats" className="w-[36%]" focus>
        <Lines n={8} />
      </Block>
      <Block label="Conversation" className="flex-1">
        <span className="h-2 w-2/5 rounded-full bg-neutral-200 dark:bg-neutral-700" />
        <span className="h-2 w-1/2 self-end rounded-full bg-neutral-300 dark:bg-neutral-600" />
        <span className="h-2 w-1/3 rounded-full bg-neutral-200 dark:bg-neutral-700" />
        <span className="h-2 w-2/5 self-end rounded-full bg-neutral-300 dark:bg-neutral-600" />
        <span className="mt-auto h-3 rounded bg-neutral-200 dark:bg-neutral-700" />
      </Block>
    </Frame>
  );
}

export function WireCommand() {
  return (
    <Frame>
      <Block className="w-[17%]">
        <Lines n={7} />
      </Block>
      <div className="relative flex min-w-0 flex-1">
        <Block label="One dense list" className="flex-1">
          <Lines n={9} />
        </Block>
        <div className="absolute inset-x-[18%] top-[22%] flex flex-col gap-1 rounded-md border border-amber-400 bg-amber-300 p-1.5 text-amber-950 shadow">
          <span className="font-semibold">Type a command</span>
          <span className="h-1.5 w-4/5 rounded-full bg-amber-500/50" />
          <span className="h-1.5 w-3/5 rounded-full bg-amber-500/50" />
        </div>
      </div>
    </Frame>
  );
}

export function WireToday() {
  return (
    <Frame>
      <Block className="w-[17%]">
        <Lines n={6} />
      </Block>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Block label="Today: 3 chats are waiting for you" focus />
        <Block label="Your agent booked 9 appointments">
          <Lines n={1} />
        </Block>
        <Block label="Campaign sent to 412 customers">
          <Lines n={1} />
        </Block>
        <Block label="Suggested: answer a new common question" className="flex-1" />
      </div>
      <Block label="Numbers" className="w-[20%]">
        <Lines n={4} />
      </Block>
    </Frame>
  );
}

export function WireCanvas() {
  const node = "rounded px-1.5 py-1 font-semibold";
  return (
    <Frame>
      <Block className="w-[13%]" label="Blocks">
        <Lines n={5} />
      </Block>
      <div className="relative min-w-0 flex-1 rounded-[5px] bg-white dark:bg-neutral-800">
        <span className={`${node} absolute top-[14%] left-[8%] bg-amber-300 text-amber-950`}>
          Customer writes
        </span>
        <span className={`${node} absolute top-[42%] left-[34%] bg-neutral-200 dark:bg-neutral-700`}>
          Agent answers
        </span>
        <span className={`${node} absolute top-[70%] left-[14%] bg-neutral-200 dark:bg-neutral-700`}>
          Book slot
        </span>
        <span className={`${node} absolute top-[70%] left-[58%] bg-neutral-200 dark:bg-neutral-700`}>
          Hand to team
        </span>
        <svg
          className="absolute inset-0 size-full text-neutral-300 dark:text-neutral-600"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="presentation"
        >
          <path
            d="M22 24 L42 42 M44 54 L26 70 M48 54 L66 70"
            stroke="currentColor"
            strokeWidth="0.8"
            fill="none"
          />
        </svg>
      </div>
      <Block className="w-[20%]" label="Step settings">
        <Lines n={5} />
      </Block>
    </Frame>
  );
}

export function WireConversational() {
  return (
    <Frame>
      <Block className="w-[17%]" label="Past requests">
        <Lines n={6} />
      </Block>
      <Block className="flex-1 items-center">
        <div className="flex w-[70%] flex-1 flex-col gap-1.5">
          <span className="h-2 w-1/2 self-end rounded-full bg-neutral-300 dark:bg-neutral-600" />
          <Lines n={2} />
          <Block label="Built for you: weekend offer campaign" focus>
            <span className="h-1.5 w-3/5 rounded-full bg-amber-500/50" />
          </Block>
          <Lines n={1} />
          <span className="mt-auto h-4 rounded border border-neutral-300 dark:border-neutral-600" />
        </div>
      </Block>
    </Frame>
  );
}

export function WireDualMode() {
  return (
    <Frame>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-center font-semibold">Owner view</span>
        <Block className="flex-1 items-center justify-center">
          <div className="flex w-4/5 flex-col gap-1.5">
            <Block label="3 things need you" focus />
            <Lines n={3} />
          </div>
        </Block>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-center font-semibold">Team view</span>
        <div className="flex min-h-0 flex-1 gap-1">
          <Block className="w-[36%]">
            <Lines n={6} />
          </Block>
          <Block className="flex-1">
            <Lines n={4} />
          </Block>
        </div>
      </div>
    </Frame>
  );
}

export function WireTriage() {
  return (
    <Frame>
      <Rail />
      <Block className="flex-1 items-center">
        <div className="flex w-[62%] flex-1 flex-col gap-1.5">
          <span className="font-semibold">3 decisions left</span>
          <Block label="Agent wants to refund Daniel. Approve, edit or reject" focus>
            <div className="flex gap-1">
              <span className="h-2 w-1/4 rounded bg-amber-500/50" />
              <span className="h-2 w-1/5 rounded bg-amber-500/50" />
              <span className="h-2 w-1/5 rounded bg-amber-500/50" />
            </div>
          </Block>
          <Block
            label="New question the agent couldn't answer"
            className="bg-neutral-100 dark:bg-neutral-900"
          />
          <Block label="Reminder message was rejected" className="bg-neutral-100 dark:bg-neutral-900" />
          <span className="mt-auto text-center">Empty means nothing needs you</span>
        </div>
      </Block>
    </Frame>
  );
}

export function WireBoard() {
  const columns = ["New enquiry", "Talking", "Booked", "Visited"];
  return (
    <Frame>
      <Rail />
      {columns.map((title, i) => (
        <Block key={title} label={title} className="flex-1">
          {Array.from({ length: 3 - (i % 2) }, (_, n) => `${title}-${n}`).map((key, n) => (
            <span
              key={key}
              className={`h-5 rounded ${
                i === 0 && n === 0 ? "bg-amber-300" : "bg-neutral-100 dark:bg-neutral-700"
              }`}
            />
          ))}
        </Block>
      ))}
    </Frame>
  );
}

export function WireWorkspace() {
  return (
    <Frame>
      <Block className="w-[20%]" label="Pages">
        <Lines n={7} />
      </Block>
      <Block className="flex-1 items-center">
        <div className="flex w-[66%] flex-1 flex-col gap-1.5">
          <span className="text-[11px] font-semibold">How we book appointments</span>
          <Lines n={3} focusFirst />
          <Lines n={4} />
          <Lines n={2} />
        </div>
      </Block>
    </Frame>
  );
}

export function WirePhone() {
  return (
    <Frame>
      <div className="flex flex-1 items-center justify-center gap-3">
        {[0, 1].map((phone) => (
          <div
            key={phone}
            className="flex h-full w-[24%] flex-col gap-1 rounded-lg bg-white p-1.5 dark:bg-neutral-800"
          >
            {phone === 0 ? (
              <>
                <Block label="3 need you" focus />
                <Block className="bg-neutral-100 dark:bg-neutral-900">
                  <Lines n={2} />
                </Block>
                <Block className="flex-1 bg-neutral-100 dark:bg-neutral-900">
                  <Lines n={2} />
                </Block>
              </>
            ) : (
              <Block className="flex-1 bg-neutral-100 dark:bg-neutral-900" label="Chat">
                <Lines n={4} />
              </Block>
            )}
            <div className="flex justify-around">
              {["a", "b", "c", "d"].map((k) => (
                <span key={k} className="size-[7px] rounded-sm bg-neutral-300 dark:bg-neutral-600" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}
