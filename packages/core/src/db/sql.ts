/** جمع‌کننده‌ی پارامترهای کوئری؛ هیچ مقداری هرگز به متن SQL چسبانده نمی‌شود. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
