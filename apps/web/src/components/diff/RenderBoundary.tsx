import { Component, type ReactNode } from "react";

import { Button } from "~/components/ui/button";

type Props = {
  children: ReactNode;
  title: string;
  /** A new value tries a failed render again without remounting one that rendered. */
  resetKey?: string | undefined;
};
type State = { failed: boolean; resetKey: string | undefined };

export class RenderBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
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
