import { Badge } from "@/components/ui/badge";
import { approaches, type Fit, recommendation } from "./data";

export const metadata = { title: "App structure approaches" };

const fitVariant: Record<Fit, "default" | "secondary" | "outline"> = {
  Strong: "default",
  Partial: "secondary",
  Weak: "outline",
};

function FitRow({ label, fit }: { label: string; fit: Fit }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant={fitVariant[fit]}>{fit}</Badge>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** Dev-only page comparing ways the product could be structured. Not linked from the app. */
export default function ApproachesPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 bg-background px-5 py-10 text-foreground sm:px-8">
      <header className="flex max-w-3xl flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Ways this product could be structured</h1>
        <p className="text-muted-foreground leading-relaxed">
          Each one is a different answer to what you see first and how you move around. The wireframes are
          grey on purpose, so the comparison is about structure and not colour. The amber block shows where
          the eye lands first.
        </p>
        <nav aria-label="Approaches" className="flex flex-wrap gap-2 pt-1">
          {approaches.map((a, i) => (
            <a key={a.id} href={`#${a.id}`} className="rounded-full border px-3 py-1 text-sm hover:bg-muted">
              {i + 1}. {a.name}
            </a>
          ))}
        </nav>
      </header>

      <div className="flex flex-col gap-8">
        {approaches.map((a, i) => (
          <section
            key={a.id}
            id={a.id}
            aria-labelledby={`${a.id}-title`}
            className="grid scroll-mt-6 gap-6 rounded-xl border p-5 sm:p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
          >
            <div className="flex flex-col gap-4">
              {a.wire}
              <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3">
                <FitRow label="For a business owner checking in" fit={a.fit.owner} />
                <FitRow label="For a team replying all day" fit={a.fit.team} />
                {a.fit.summary ? <p className="pt-1 text-sm leading-relaxed">{a.fit.summary}</p> : null}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex flex-col gap-2">
                <h2 id={`${a.id}-title`} className="text-xl font-semibold tracking-tight">
                  {i + 1}. {a.name}
                </h2>
                <p className="leading-relaxed">{a.idea}</p>
                <p className="text-sm text-muted-foreground">First screen: {a.firstScreen}</p>
              </div>

              {a.examples.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-semibold">Products that work this way</h3>
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {a.examples.map((ex) => (
                      <li key={ex.name}>
                        <a
                          href={ex.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium underline underline-offset-4"
                        >
                          {ex.name}
                        </a>
                        <span className="text-muted-foreground">: {ex.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="grid gap-5 sm:grid-cols-2">
                <List title="Works well" items={a.strengths} />
                <List title="Works badly" items={a.weaknesses} />
              </div>
            </div>
          </section>
        ))}
      </div>

      <section
        aria-labelledby="rec-title"
        className="flex flex-col gap-5 rounded-xl border-2 border-foreground p-5 sm:p-6"
      >
        <div className="flex max-w-3xl flex-col gap-2">
          <h2 id="rec-title" className="text-xl font-semibold tracking-tight">
            {recommendation.title}
          </h2>
          <p className="leading-relaxed">{recommendation.summary}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {recommendation.parts.map((part) => (
            <div key={part.who} className="flex flex-col gap-2 rounded-lg bg-muted/60 p-4">
              <h3 className="font-semibold">{part.who}</h3>
              <p className="text-sm leading-relaxed">{part.what}</p>
              <p className="mt-auto pt-2 text-xs text-muted-foreground">Combines: {part.from}</p>
            </div>
          ))}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground leading-relaxed">{recommendation.note}</p>
      </section>
    </main>
  );
}
