interface SecretProvider {
  getSecret(name: string): Promise<string | undefined>;
}

class EnvSecretProvider implements SecretProvider {
  async getSecret(name: string): Promise<string | undefined> {
    return process.env[name];
  }
}

class JsonSecretProvider implements SecretProvider {
  private cache: Record<string, string>;

  constructor() {
    const raw = process.env.SECRET_MANAGER_JSON;
    if (!raw) {
      this.cache = {};
      return;
    }

    try {
      this.cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.cache = {};
    }
  }

  async getSecret(name: string): Promise<string | undefined> {
    return this.cache[name];
  }
}

class CompositeSecretProvider implements SecretProvider {
  constructor(private readonly providers: SecretProvider[]) {}

  async getSecret(name: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      const value = await provider.getSecret(name);
      if (value) {
        return value;
      }
    }
    return undefined;
  }
}

function envKeyForTenant(base: string, tenantId: string): string {
  return `${base}_${tenantId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface WellSkyCredentials {
  username: string;
  password: string;
}

export async function loadWellSkyCredentials(tenantId: string): Promise<WellSkyCredentials> {
  const provider = new CompositeSecretProvider([new EnvSecretProvider(), new JsonSecretProvider()]);

  const tenantUsernameKey = envKeyForTenant("WELLSKY_USERNAME", tenantId);
  const tenantPasswordKey = envKeyForTenant("WELLSKY_PASSWORD", tenantId);

  const username =
    (await provider.getSecret(tenantUsernameKey)) ||
    (await provider.getSecret(`wellsky/${tenantId}/username`)) ||
    (await provider.getSecret("WELLSKY_USERNAME"));

  const password =
    (await provider.getSecret(tenantPasswordKey)) ||
    (await provider.getSecret(`wellsky/${tenantId}/password`)) ||
    (await provider.getSecret("WELLSKY_PASSWORD"));

  if (!username || !password) {
    throw new Error("Missing WellSky credentials in environment or secret manager.");
  }

  return { username, password };
}
