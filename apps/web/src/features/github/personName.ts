/** Who a GitHub author, actor, assignee or reviewer is: their login, or "deleted user" when GitHub sends none. */
export const personName = (person: { readonly login: string } | null | undefined) =>
  person?.login ?? "deleted user";
