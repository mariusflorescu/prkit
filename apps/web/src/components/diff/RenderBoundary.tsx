import { Component, type ReactNode } from "react";

import { Button } from "~/components/ui/button";

export class RenderBoundary extends Component<
  { children: ReactNode; title: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-5"
        role="alert"
      >
        <p className="text-sm">{this.props.title} could not be displayed.</p>
        <p className="text-sm text-muted-foreground">The rest of the guide is still available.</p>
        <Button variant="outline" size="sm" onClick={() => this.setState({ failed: false })}>
          Retry
        </Button>
      </div>
    );
  }
}
