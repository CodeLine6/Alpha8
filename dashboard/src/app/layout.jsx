import './globals.css';
import Sidebar from '@/components/Sidebar';

export const metadata = {
    title: 'Alpha8 — Trading Dashboard',
    description: 'Real-time algorithmic trading dashboard',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en" className="h-full">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
            </head>
            <body className="h-full bg-slate-950 text-slate-100 antialiased">
                <Sidebar />
                <main className="min-h-screen" style={{ marginLeft: '60px' }}>
                    <div className="max-w-screen-2xl mx-auto px-6 py-8">
                        {children}
                    </div>
                </main>
            </body>
        </html>
    );
}
