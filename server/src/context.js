// 방 대화 원본(JSONL)의 마지막 Claude 답에서 지금 컨텍스트 크기를 뽑는다.
// 방 멤버 모두 같은 대화를 이어 쓰므로 방마다 하나의 값이다

/**
 * @param {string|null} text 대화 원본
 * @returns {{tokens: number, model: string|null, compacted?: true}|null} 답이 없으면 null, 압축 뒤 아직 답이 없으면 compacted
 */
export function contextFromTranscript(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'compact_boundary') return { tokens: 0, model: null, compacted: true }; // 압축 뒤 아직 답이 없음
    const u = e.type === 'assistant' ? e.message?.usage : null;
    if (!u) continue;
    const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0);
    const tokens = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
    return { tokens, model: typeof e.message.model === 'string' ? e.message.model : null };
  }
  return null;
}
