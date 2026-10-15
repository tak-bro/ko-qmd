declare module "picomatch" {
  export default function picomatch(pattern: string | string[], options?: Record<string, unknown>): (input: string) => boolean;
}
