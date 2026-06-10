import { redirect } from 'next/navigation';

export default function DisclosureSearchRedirectPage() {
  redirect('/disclosures?query=bitcoin%2C%20cryptocurrency%2C%20digital%20assets');
}
