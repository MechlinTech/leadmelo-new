import { headers } from 'next/headers';
import ThemeSync from './ThemeSync';

// The boot script paints the saved theme before the rest of the page. ThemeSync keeps it
// after a client navigation replaces the document theme.
export default async function ThemeBoot() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <>
    <script src="/leadmelo-boot.js" nonce={nonce} />
    <ThemeSync />
  </>;
}
