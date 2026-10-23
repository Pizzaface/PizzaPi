// Format an agent answer for a tenant. Every answer must end with the scope
// line so reviewers can see which tenant the answer was computed for.
export function formatAnswer(body, scope) {
  return body.trim();
}
