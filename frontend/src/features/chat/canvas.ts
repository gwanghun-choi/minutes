/**
 * One centre axis for the whole conversation.
 *
 * The canvas is as wide as the window; the reading column is not. Questions,
 * answers, evidence, and the composer all sit on this same axis, so nothing
 * shifts sideways as the conversation grows. 48rem is where a Korean line stops
 * being comfortable to track back from.
 */
export const CANVAS = "mx-auto w-full max-w-3xl px-4 sm:px-6";
