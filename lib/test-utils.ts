import type { PropsWithChildren } from 'react';
import { Component } from 'react';

type State = { errorMessage: string | null };

type Props = PropsWithChildren<{
  onError?: (error: any) => void;
}>;

export class ErrorBoundary extends Component<Props> {
  state: State = { errorMessage: null };

  static getDerivedStateFromError(error: any): State {
    return { errorMessage: typeof error === 'string' ? error : error.message };
  }
  render() {
    if (this.state.errorMessage) {
      this.props.onError?.(this.state.errorMessage);

      return this.state.errorMessage;
    }

    return this.props.children;
  }
}
