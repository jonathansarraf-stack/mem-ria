export interface LLMAdapter {
  synthesize(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export function anthropicAdapter(
  apiKey: string,
  model = 'claude-haiku-4-5-20251001',
): LLMAdapter {
  return {
    async synthesize(system, user, opts) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: opts?.maxTokens ?? 1024,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })

      if (!res.ok) {
        throw new Error(`Anthropic API error: ${res.status}`)
      }

      const json = (await res.json()) as {
        content: Array<{ type: string; text?: string }>
      }

      if (!json.content || json.content.length === 0) {
        throw new Error('Anthropic: empty content in response')
      }

      return json.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    },
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

export function openaiAdapter(
  apiKey: string,
  model = 'gpt-4o-mini',
): LLMAdapter {
  return {
    async synthesize(system, user, opts) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: opts?.maxTokens ?? 1024,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })

      if (!res.ok) {
        throw new Error(`OpenAI API error: ${res.status}`)
      }

      const json = (await res.json()) as {
        choices: Array<{ message: { content: string | null } }>
      }

      if (!json.choices || json.choices.length === 0) {
        throw new Error('OpenAI: empty choices in response')
      }

      return json.choices[0]?.message.content ?? ''
    },
  }
}

// ── Google Gemini ────────────────────────────────────────────────────────────

export function googleAdapter(
  apiKey: string,
  model = 'gemini-2.0-flash',
): LLMAdapter {
  return {
    async synthesize(system, user, opts) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: opts?.maxTokens ?? 1024,
          },
        }),
      })

      if (!res.ok) {
        throw new Error(`Google API error: ${res.status}`)
      }

      const json = (await res.json()) as {
        candidates: Array<{
          content: { parts: Array<{ text?: string }> }
        }>
      }

      if (!json.candidates || json.candidates.length === 0) {
        throw new Error('Google: empty candidates in response')
      }

      return (
        json.candidates[0]?.content.parts
          .map((p) => p.text ?? '')
          .join('') ?? ''
      )
    },
  }
}

// ── Custom / Noop ────────────────────────────────────────────────────────────

export function customAdapter(
  fn: (system: string, user: string) => Promise<string>,
): LLMAdapter {
  return { synthesize: (system, user) => fn(system, user) }
}

export function noopAdapter(): LLMAdapter {
  return { synthesize: async () => '' }
}
