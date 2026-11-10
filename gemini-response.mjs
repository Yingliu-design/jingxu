// streamGenerateContent returns a JSON array of response chunks.
export function mergeGeminiResponse(payload) {
  if (!Array.isArray(payload)) return payload;
  const candidates = new Map();
  let merged = {};
  for (const chunk of payload) {
    if (chunk.error) return { error: chunk.error };
    merged = { ...merged, ...chunk };
    for (const candidate of chunk.candidates || []) {
      const index = candidate.index ?? 0;
      const previous = candidates.get(index);
      candidates.set(index, {
        ...previous, ...candidate,
        content: {
          role: candidate.content?.role || previous?.content?.role || "model",
          parts: [
            ...(previous?.content?.parts || []),
            ...(candidate.content?.parts || []).filter((part) => !part.thought)
          ]
        }
      });
    }
  }
  return { ...merged, candidates: [...candidates.values()] };
}
