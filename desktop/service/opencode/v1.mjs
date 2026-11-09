import { observerFromEnvironment } from './observer.mjs';

export default async function alphaObserver({ directory }) {
  const observe = observerFromEnvironment(directory);
  return { event: async ({ event }) => observe(event) };
}
