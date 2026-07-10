/**
 * Pure, side-effect-free authorization helpers for node-pairing approvals.
 *
 * Mirrors upstream's privilege-delegation model for pairing approvals
 * (`src/infra/node-pairing-authz.ts` + `src/shared/operator-scope-compat.ts`):
 * a pairing request declares device capabilities (its `requestedScopes`); the
 * operator who approves it must already hold the operator scope those
 * capabilities demand. An approver can never grant more than they hold.
 *
 * Two pure steps:
 *  1. Map the requested device capabilities to the operator approval scopes
 *     they require (`resolveNeonNodePairingRequiredApprovalScopes`):
 *       - any admin-level capability  -> ["operator.pairing", "operator.admin"]
 *       - any other capability        -> ["operator.pairing", "operator.write"]
 *       - pairing only / none         -> ["operator.pairing"]
 *  2. Check whether the approver's own scopes satisfy every required scope
 *     (`resolveNeonNodePairingForbiddenApprovalScope`), using operator-scope
 *     semantics (admin covers all, write covers read+write).
 *
 * No I/O, no token issuance, no live side effect. The record writer
 * (`recordNeonNodePairingApproval`) is the only consumer that persists.
 */

export type TNeonNodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_SCOPE_PREFIX = "operator.";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_PAIRING_SCOPE: TNeonNodeApprovalScope = "operator.pairing";

/** A device capability that demands the highest (admin) operator approval scope. */
function isAdminLevelCapability(scope: string): boolean {
  const trimmed = scope.trim();
  return trimmed === OPERATOR_ADMIN_SCOPE || trimmed.endsWith(".admin");
}

function normalizeScopeList(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed.length > 0) {
      out.add(trimmed);
    }
  }
  return [...out];
}

/**
 * Derive the operator approval scopes a pairing request requires from the
 * device capabilities it asks for. Capabilities beyond `operator.pairing`
 * itself are what raise the bar; `operator.pairing` is always required.
 */
export function resolveNeonNodePairingRequiredApprovalScopes(
  requestedScopes: readonly string[]
): TNeonNodeApprovalScope[] {
  const capabilities = normalizeScopeList(requestedScopes).filter(
    (scope) => scope !== OPERATOR_PAIRING_SCOPE
  );

  if (capabilities.some(isAdminLevelCapability)) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
  }
  if (capabilities.length > 0) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
  }
  return [OPERATOR_PAIRING_SCOPE];
}

/**
 * Operator-scope satisfaction: admin covers everything, write covers read+write,
 * read covers read, otherwise an exact grant is required. Non-`operator.` scopes
 * are never satisfied (the required approval scopes are always operator scopes).
 */
function operatorScopeSatisfied(requiredScope: string, granted: ReadonlySet<string>): boolean {
  if (!requiredScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  if (granted.has(OPERATOR_ADMIN_SCOPE)) {
    return true;
  }
  if (requiredScope === OPERATOR_READ_SCOPE) {
    return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
  }
  if (requiredScope === OPERATOR_WRITE_SCOPE) {
    return granted.has(OPERATOR_WRITE_SCOPE);
  }
  return granted.has(requiredScope);
}

/** True when the approver's scopes satisfy every required approval scope. */
export function neonOperatorScopesAllow(params: {
  readonly requiredScopes: readonly string[];
  readonly approverScopes: readonly string[];
}): boolean {
  const required = normalizeScopeList(params.requiredScopes);
  if (required.length === 0) {
    return true;
  }
  const granted = new Set(normalizeScopeList(params.approverScopes));
  return required.every((scope) => operatorScopeSatisfied(scope, granted));
}

/**
 * Resolve the first required approval scope the approver does not hold for a
 * pairing request, or null when the approver may approve it. Pure decision
 * logic — the caller decides whether to refuse.
 */
export function resolveNeonNodePairingForbiddenApprovalScope(params: {
  readonly requestedScopes: readonly string[];
  readonly approverScopes: readonly string[];
}): TNeonNodeApprovalScope | null {
  const required = resolveNeonNodePairingRequiredApprovalScopes(params.requestedScopes);
  for (const scope of required) {
    if (!neonOperatorScopesAllow({ requiredScopes: [scope], approverScopes: params.approverScopes })) {
      return scope;
    }
  }
  return null;
}
