import { Buffer } from 'buffer';

export interface RequirementTextSource {
  id: string;
  summary: string;
}

/** Replace exact large manifest text while preserving the source reference. */
export function deduplicateUserText(
  text: string,
  requirements: readonly RequirementTextSource[]
): { text: string; deduplicatedChars: number; references: string[] } {
  const candidates = requirements
    .filter((requirement) => requirement.summary && requirement.summary.length >= 80)
    .sort((a, b) => b.summary.length - a.summary.length);
  let result = text;
  let deduplicatedChars = 0;
  const references: string[] = [];
  for (const requirement of candidates) {
    if (!result.includes(requirement.summary)) continue;
    const replacement = `[See task.requirements ${requirement.id}]`;
    const removed = requirement.summary.length - replacement.length;
    if (removed <= 0) continue;
    const count = result.split(requirement.summary).length - 1;
    if (count <= 0) continue;
    result = result.split(requirement.summary).join(replacement);
    deduplicatedChars += removed * count;
    references.push(requirement.id);
  }
  return { text: result, deduplicatedChars, references: [...new Set(references)] };
}

export function pruneContext(
  rep: Record<string, any>,
  turns: Array<{ role: string; text: string }>,
  maxHistoryChars: number
): Record<string, any> {
  // Clone inputs to avoid mutation
  const clonedRep = JSON.parse(JSON.stringify(rep));
  const clonedTurns = JSON.parse(JSON.stringify(turns));

  // Helper: UTF-8 byte length
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

  // Helper: Estimate tokens as ceil(bytes / 2)
  const estimateTokens = (bytes: number): number => Math.ceil(bytes / 2);

  // Step 1: Deduplicate USER text by replacing full requirement summaries >= 80 chars, longest first
  const requirements = clonedRep.requirements || [];
  let deduplicatedChars = 0;
  const dedupedTurns: Array<{ role: string; text: string }> = [];

  for (const turn of clonedTurns) {
    let newText = turn.text;
    if (turn.role === 'user') {
      const deduplicated = deduplicateUserText(newText, requirements);
      newText = deduplicated.text;
      deduplicatedChars += deduplicated.deduplicatedChars;
    }
    dedupedTurns.push({ role: turn.role, text: newText });
  }

  // Step 2: Render history from all deduped turns
  const renderHistory = (selectedTurns: Array<{ role: string; text: string }>): string => {
    return selectedTurns.map(t => `[${t.role}]: ${t.text}`).join('\n\n');
  };

  // Initial selection: all deduped turns
  let selectedTurns: Array<{ role: string; text: string }> = [...dedupedTurns];

  // Helper: Refresh history metadata
  const refreshHistory = (
    selected: Array<{ role: string; text: string }>,
    original: Array<{ role: string; text: string }>
  ): void => {
    const rendered = renderHistory(selected);
    const originalRendered = renderHistory(original);
    const renderedChars = rendered.length;
    const originalChars = originalRendered.length;
    const elidedChars = Math.max(0, originalChars - renderedChars);
    const omittedTurns = original.length - selected.length;
    const truncated = omittedTurns > 0;

    clonedRep.history = {
      text: rendered,
      truncated,
      chars: turns.reduce((sum, t) => sum + t.text.length, 0),
      rendered_chars: renderHistory(turns).length,
      elided_chars: elidedChars,
      turns: original.length,
      turns_omitted: omittedTurns,
    };
  };

  // Initial refresh
  refreshHistory(selectedTurns, dedupedTurns);

  // Step 3: Drop oldest assistant turns until rendered history <= maxHistoryChars
  while (true) {
    const rendered = renderHistory(selectedTurns);
    if (rendered.length <= maxHistoryChars) break;

    // Find oldest assistant turn
    const idx = selectedTurns.findIndex(t => t.role === 'assistant');
    if (idx === -1) break; // Only users remain, keep complete

    selectedTurns.splice(idx, 1);
    refreshHistory(selectedTurns, dedupedTurns);
  }

  // Step 4: Target canonical UTF-8 bytes 28000
  const TARGET_BYTES = 28000;

  // Identify protected items
  const observations = clonedRep.observations || [];
  const verificationChecks = clonedRep.verification_checks || [];
  const recentActions = clonedRep.recent_actions || [];

  // Protect newest 3 input observations
  const protectedObsIds = new Set<string>();
  // Take last 3 observations as newest
  const newestObs = observations.slice(-3);
  for (const obs of newestObs) {
    if (obs.id) protectedObsIds.add(obs.id);
  }

  // Protect latest 2 executed errors
  const latestErrors = observations.filter((o: any) => o.provenance === 'executed' && !o.ok).slice(-2);
  for (const obs of latestErrors) {
    if (obs.id) protectedObsIds.add(obs.id);
  }

  // Protect verification check evidence IDs
  for (const check of verificationChecks) {
    if (check.evidence_id) protectedObsIds.add(check.evidence_id);
  }

  // Helper: Compute total representation bytes
  const computeRepBytes = (): number => {
    const jsonStr = JSON.stringify(clonedRep);
    return byteLen(jsonStr);
  };

  // Helper: Update omitted evidence IDs union at top level
  const updateOmittedEvidence = (): void => {
    const currentObsIds = new Set<string>();
    for (const obs of clonedRep.observations || []) {
      if (obs.id) currentObsIds.add(obs.id);
    }
    const allOriginalObsIds = new Set<string>();
    for (const obs of rep.observations || []) {
      if (obs.id) allOriginalObsIds.add(obs.id);
    }
    const omitted = [...allOriginalObsIds].filter(id => !currentObsIds.has(id));
    const existingOmitted = clonedRep.omitted_evidence_ids || [];
    const merged = new Set([...existingOmitted, ...omitted]);
    clonedRep.omitted_evidence_ids = [...merged];
    clonedRep.omitted_observation_count = merged.size;
  };

  // Helper: Validate recent_actions references
  const validateRecentActions = (): void => {
    const currentObsIds = new Set<string>();
    for (const obs of clonedRep.observations || []) {
      if (obs.id) currentObsIds.add(obs.id);
    }
    for (const act of clonedRep.recent_actions || []) {
      if (act.arguments_ref && !currentObsIds.has(act.arguments_ref)) {
        delete act.arguments_ref;
        act.arguments_omitted = true;
      }
    }
    if (Array.isArray(clonedRep.context_selection?.truncation_metadata)) {
      clonedRep.context_selection.truncation_metadata = clonedRep.context_selection.truncation_metadata.filter(
        (entry: any) => currentObsIds.has(entry.id)
      );
    }
  };

  // Helper: Refresh metadata with bounded iteration
  const refreshMetadata = (): void => {
    let iterations = 0;
    const maxIterations = 10;
    while (iterations < maxIterations) {
      const bytes = computeRepBytes();
      const estTokens = estimateTokens(bytes);
      const budgetExceeded = bytes > TARGET_BYTES;

      clonedRep.context_selection = {
        ...(clonedRep.context_selection || {}),
        target_bytes: TARGET_BYTES,
        estimate_method: 'utf8-bytes-divided-by-two',
        pruned_history_turns_count: dedupedTurns.length - selectedTurns.length,
        history_turns_omitted: dedupedTurns.length - selectedTurns.length,
        pruned_observations_count: rep.observations.length - clonedRep.observations.length,
        deduplicated_chars: deduplicatedChars,
        estimated_tokens: estTokens,
        representation_bytes: bytes,
        budget_exceeded: budgetExceeded,
      };

      if (computeRepBytes() === bytes) break;
      iterations++;
    }
  };

  // Add initial metadata before pruning
  refreshMetadata();

  // Step 5: While over target bytes, drop oldest unprotected observation
  while (computeRepBytes() > TARGET_BYTES) {
    // Try dropping oldest assistant anywhere in selected chronology first
    const assistantIdx = selectedTurns.findIndex(t => t.role === 'assistant');
    if (assistantIdx !== -1) {
      selectedTurns.splice(assistantIdx, 1);
      refreshHistory(selectedTurns, dedupedTurns);
      refreshMetadata();
      continue;
    }

    // Then drop oldest unprotected observation
    const obsList = clonedRep.observations || [];
    let dropped = false;
    for (let i = 0; i < obsList.length; i++) {
      const obs = obsList[i];
      if (obs.id && !protectedObsIds.has(obs.id)) {
        obsList.splice(i, 1);
        dropped = true;
        break;
      }
    }

    if (!dropped) {
      // No optional items remain, retain mandatory oversize
      break;
    }

    updateOmittedEvidence();
    validateRecentActions();
    refreshMetadata();
  }

  // Final metadata refresh
  validateRecentActions();
  refreshMetadata();

  return clonedRep;
}
