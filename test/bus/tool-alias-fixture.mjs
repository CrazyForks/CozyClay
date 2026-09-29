// A domain command module owns its alias; the binding knows neither this
// command nor its argument translation.
export function register(registry) {
  registry.registerToolAlias('arrange_characters', 'fixtureItem.set', args => ({ id: args.item, set: { amount: args.amount } }));
}
