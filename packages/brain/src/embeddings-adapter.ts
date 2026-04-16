export interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>
  readonly dimensions: number
  readonly model: string
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

export function openaiEmbeddings(
  apiKey: string,
  model = 'text-embedding-3-small',
): EmbeddingAdapter {
  return {
    dimensions: 1536,
    model,

    async embed(text) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenAI Embeddings ${res.status}: ${body}`)
      }

      const json = (await res.json()) as {
        data: Array<{ embedding: number[] }>
      }

      return json.data[0].embedding
    },
  }
}

// ── Google Gemini ────────────────────────────────────────────────────────────

export function geminiEmbeddings(
  apiKey: string,
  model = 'embedding-001',
): EmbeddingAdapter {
  return {
    dimensions: 768,
    model,

    async embed(text) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Gemini Embeddings ${res.status}: ${body}`)
      }

      const json = (await res.json()) as {
        embedding: { values: number[] }
      }

      return json.embedding.values
    },
  }
}

// ── Voyage ───────────────────────────────────────────────────────────────────

export function voyageEmbeddings(
  apiKey: string,
  model = 'voyage-3-lite',
): EmbeddingAdapter {
  return {
    dimensions: 512,
    model,

    async embed(text) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Voyage Embeddings ${res.status}: ${body}`)
      }

      const json = (await res.json()) as {
        data: Array<{ embedding: number[] }>
      }

      return json.data[0].embedding
    },
  }
}

// ── Custom / Noop ────────────────────────────────────────────────────────────

export function customEmbeddings(
  fn: (text: string) => Promise<number[]>,
  dim: number,
  modelName = 'custom',
): EmbeddingAdapter {
  return {
    dimensions: dim,
    model: modelName,
    embed: fn,
  }
}

export function noopEmbeddings(dim = 128): EmbeddingAdapter {
  return {
    dimensions: dim,
    model: 'noop',
    embed: async () => new Array(dim).fill(0) as number[],
  }
}
