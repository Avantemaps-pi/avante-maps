import React, { useEffect, useState } from 'react';
import { useLocation } from '@/lib/router-compat';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Mail, Phone, MapPin, Send } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import MetaTags from '@/components/seo/MetaTags';

const FAQS = [
  {
    q: 'What is Avante Maps?',
    a: 'Avante Maps is a platform that helps users find businesses that accept Pi cryptocurrency as payment.',
  },
  {
    q: 'How do I register my business?',
    a: 'You can register your business by clicking on the "Registered Business" option in the navigation menu and following the steps.',
  },
  {
    q: 'Is Avante Maps affiliated with Pi Network?',
    a: 'No. Avante Maps is an independent platform created by a Pi Network enthusiast to support the Pi ecosystem.',
  },
];

const Contact = () => {
  const location = useLocation();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [department, setDepartment] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (location.hash) {
      const el = document.querySelector(location.hash);
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 300);
      }
    }
  }, [location.hash]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!department) {
      toast({ title: 'Please select a department', variant: 'destructive' });
      return;
    }
    const subject = encodeURIComponent(`Message from ${name || 'Website Visitor'}`);
    const body = encodeURIComponent(`Name: ${name}\nEmail: ${email}\n\n${message}`);
    window.open(`mailto:${department}?subject=${subject}&body=${body}`, '_blank');
    toast({ title: 'Opening your email client...', description: 'Your message details have been pre-filled.' });
  };

  return <AppLayout title="Contact Us">
      <MetaTags
        title="Contact Avante Maps"
        description="Contact the Avante Maps team — email, phone and office address. Reach out for support, partnerships, business listings or general inquiries."
        keywords={['contact avante maps', 'support', 'partnerships', 'pi network help']}
        ogType="website"
        structuredData={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map(({ q, a }) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        }}
      />
      <div className="max-w-5xl mx-auto space-y-8 p-4 sm:p-6 animate-fade-in">
        <div className="space-y-4">
          <p className="text-muted-foreground">Have questions or feedback? We'd love to hear from you.</p>
        </div>

        <Card className="material-card overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-2 mb-2">
                <Mail className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-medium">Email</h3>
              </div>
              <p className="text-sm break-all">support@avantemaps.com</p>
              <p className="text-xs text-muted-foreground mt-1">For questions and support</p>
            </div>

            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-2 mb-2">
                <Phone className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-medium">Phone</h3>
              </div>
              <p className="text-sm">+27 (68) 342-2444</p>
              <p className="text-xs text-muted-foreground mt-1">+27 (62) 476-7535</p>
            </div>

            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-medium">Address</h3>
              </div>
              <p className="text-sm">Pietermaritzburg, South Africa</p>
            </div>
          </div>
        </Card>

        <Card id="send-message" className="material-card scroll-mt-4">
          <CardHeader>
            <CardTitle>Send us a message</CardTitle>
            <CardDescription>
              We'll get back to you as soon as possible.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="name" className="text-sm font-medium">
                    Name
                  </label>
                  <Input id="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <label htmlFor="email" className="text-sm font-medium">
                    Email
                  </label>
                  <Input id="email" type="email" placeholder="Your email address" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="subject" className="text-sm font-medium">
                  Department
                </label>
                <Select value={department} onValueChange={setDepartment}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inquiries@avantemaps.com">Inquiries</SelectItem>
                    <SelectItem value="support@avantemaps.com">Support</SelectItem>
                    <SelectItem value="businesses@avantemaps.com">Businesses</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label htmlFor="message" className="text-sm font-medium">
                  Message
                </label>
                <Textarea id="message" placeholder="How can we help you?" rows={5} className="resize-none" value={message} onChange={(e) => setMessage(e.target.value)} required />
              </div>
              <Button className="w-full sm:w-auto" type="submit">
                <Send className="mr-2 h-4 w-4" />
                Send Message
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="material-card">
          <CardHeader>
            <CardTitle>Frequently Asked Questions</CardTitle>
            <CardDescription>
              Quick answers to common questions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {FAQS.map(({ q, a }, i) => (
                <AccordionItem key={i} value={`item-${i + 1}`}>
                  <AccordionTrigger>{q}</AccordionTrigger>
                  <AccordionContent>{a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>

        <div className="flex flex-col items-center justify-center space-y-4 py-8">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Avante Maps Pty Ltd. All rights
            reserved.
          </p>
        </div>
      </div>
    </AppLayout>;
};
export default Contact;
