import { cn } from "@relay/ui/lib/utils";

/**
 * The brand light behind the sign-in panel and the landing page: a violet glow from the top right,
 * a soft wash from the bottom left, and faint grid lines that fade out downwards.
 * Place it inside a `relative` element with the `bg-[#1c0f45]` base colour.
 */
export function BrandBackdrop({ className }: { className?: string }) {
  return (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-[radial-gradient(90%_70%_at_100%_0%,#7c4dff_0%,transparent_60%),radial-gradient(80%_60%_at_20%_110%,#4b23b8_0%,transparent_65%)] opacity-90",
          className,
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:48px_48px] [mask-image:linear-gradient(to_bottom,black,transparent_55%)]",
          className,
        )}
      />
    </>
  );
}
