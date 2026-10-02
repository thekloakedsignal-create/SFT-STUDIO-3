import OpenAI from "openai";

export interface GradientOptions {
  modelAccessKey?: string;
  model_access_key?: string;
  apiKey?: string;
  baseURL?: string;
}

export class Gradient {
  public chat: {
    completions: {
      create: (params: {
        model?: string;
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
        [key: string]: any;
      }) => Promise<any>;
    };
  };

  private client: OpenAI;

  constructor(options?: GradientOptions) {
    const key = options?.modelAccessKey || 
                options?.model_access_key || 
                options?.apiKey || 
                process.env.MODEL_ACCESS_KEY || 
                process.env.DIGITALOCEAN_API_KEY || 
                process.env.DO_INFERENCE_KEY || 
                "";

    this.client = new OpenAI({
      apiKey: key.trim(),
      baseURL: options?.baseURL || "https://inference.do-ai.run/v1"
    });

    this.chat = {
      completions: {
        create: async (params) => {
          const rawModel = params.model || process.env.DO_MODEL || "glm-5.3-flash";
          const model = rawModel === "glm-3.5-flash" ? "glm-5.3-flash" : rawModel;
          const maxTokens = Math.min(params.max_tokens ?? 8192, 8192);

          return await this.client.chat.completions.create({
            ...params,
            messages: params.messages as any,
            model,
            max_tokens: maxTokens
          });
        }
      }
    };
  }
}
