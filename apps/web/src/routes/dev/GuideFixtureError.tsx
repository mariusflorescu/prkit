import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";

import { FixturePicker } from "./FixturePicker";

export function GuideFixtureError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-start gap-5 p-8" role="alert">
      <FixturePicker />
      <h1 className="text-xl font-semibold">This fixture could not be shown</h1>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
        {error instanceof Error
          ? error.message
          : "The fixture could not be loaded. Choose another fixture or try again."}
      </p>
      <Button variant="outline" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
