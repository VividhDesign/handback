import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles/app.css';
import { Layout } from './components/Layout.tsx';
import { Home } from './pages/Home.tsx';
import { Judge } from './pages/Judge.tsx';
import { Rent } from './pages/Rent.tsx';
import { Booking } from './pages/Booking.tsx';
import { Desk } from './pages/Desk.tsx';
import { Inventory } from './pages/Inventory.tsx';
import { Evidence } from './pages/Evidence.tsx';
import { NotFound } from './pages/NotFound.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="judge" element={<Judge />} />
          <Route path="rent" element={<Rent />} />
          <Route path="booking/:token" element={<Booking />} />
          <Route path="shop" element={<Desk />} />
          <Route path="shop/inventory" element={<Inventory />} />
          <Route path="e/:token" element={<Evidence />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
