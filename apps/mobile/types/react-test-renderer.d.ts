// Minimal typings for react-test-renderer.
//
// The package ships no types and DefinitelyTyped's are not installed (adding
// @types would pull a React 18 tree alongside our React 19 one). Only the
// surface the component tests actually use is declared here, so a wrong call
// is still a type error rather than `any`.

declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestInstance {
    type: unknown;
    props: Record<string, any>;
    parent: ReactTestInstance | null;
    children: (ReactTestInstance | string)[];
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
    findByType(type: unknown): ReactTestInstance;
    findAllByType(type: unknown): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(props: Record<string, unknown>): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    toJSON(): unknown;
    toTree(): unknown;
    update(element: ReactElement): void;
    unmount(): void;
  }

  export function create(
    element: ReactElement,
    options?: Record<string, unknown>,
  ): ReactTestRenderer;

  export function act(callback: () => void | Promise<void>): Promise<void> & {
    then(onfulfilled: () => void): void;
  };

  const _default: {
    create: typeof create;
    act: typeof act;
    ReactTestRenderer: ReactTestRenderer;
  };
  export default _default;
}
