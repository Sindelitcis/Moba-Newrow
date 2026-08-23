/**
 * Ambient JSX types for Newstack.
 *
 * `@moureau/newstack` ships no global `JSX` namespace of its own, and with
 * `strict` on, every element in a `.tsx` file is otherwise an implicit-`any`
 * error ("JSX element implicitly has type 'any' because no interface
 * 'JSX.IntrinsicElements' exists"). That is the *only* thing standing between
 * this project and a strict type-check, so it is declared here rather than
 * giving up strictness for the whole codebase.
 *
 * Deliberately permissive: Newstack is not React, and typing its attribute
 * surface properly would mean re-deriving the whole HTML attribute table plus
 * its own additions (`bind`, `ref`, `route`, `key`, `persistent`, `html`) -
 * and getting that wrong would reject valid markup, which is worse than not
 * checking it. What this *does* buy is a strict type-check over every
 * expression *inside* the braces, which is where the real logic lives.
 *
 * Newstack's own conventions, none of which this file can enforce for you:
 * `class` not `className`, `style` as a string not an object, lowercase DOM
 * event names (`onclick`, `oninput`), and component methods that take exactly
 * one argument: the context object.
 */
declare namespace JSX {
    /** What a JSX expression evaluates to. Newstack's `render()` returns `any`. */
    type Element = unknown;

    interface IntrinsicElements {
        [tag: string]: Record<string, unknown>;
    }

    /** Marks `children` as the prop children are passed through, for function components. */
    interface ElementChildrenAttribute {
        children: unknown;
    }
}
