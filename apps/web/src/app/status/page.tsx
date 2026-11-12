import { SystemStatus } from "@/components/system-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function StatusPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Relay</CardTitle>
          <CardDescription>Development workspace. Sign-in comes next.</CardDescription>
        </CardHeader>
        <CardContent>
          <SystemStatus />
        </CardContent>
      </Card>
    </main>
  );
}
