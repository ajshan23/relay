import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type Field = {
  name: string;
  label: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
};

/** A GET form: filters live in the URL, so a filtered page can be shared or bookmarked. */
export function Filters({
  fields,
  values,
  action,
}: {
  fields: Field[];
  values: Record<string, string>;
  action: string;
}) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-b px-5 py-4">
      {fields.map((f) => (
        <div key={f.name} className="flex flex-col gap-1">
          <Label htmlFor={`f-${f.name}`} className="text-xs text-muted-foreground">
            {f.label}
          </Label>
          {f.options ? (
            <Select name={f.name} defaultValue={values[f.name] || "any"}>
              <SelectTrigger id={`f-${f.name}`} className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={`f-${f.name}`}
              name={f.name}
              defaultValue={values[f.name] ?? ""}
              placeholder={f.placeholder}
              className="h-8 w-44"
            />
          )}
        </div>
      ))}
      <Button type="submit" size="sm" variant="outline">
        Apply
      </Button>
      <Button asChild size="sm" variant="ghost">
        <a href={action}>Clear</a>
      </Button>
    </form>
  );
}

export function param(sp: Record<string, string | string[] | undefined>, key: string): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s !== "any" ? s : "";
}
