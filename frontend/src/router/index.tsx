import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppLayout from '../layouts/AppLayout';
import Overview from '../pages/Overview';
import PointNew from '../pages/PointNew';
import PointDetail from '../pages/PointDetail';
import Routes from '../pages/Routes';
import MapView from '../pages/MapView';
import Rectify from '../pages/Rectify';
import Itinerary from '../pages/Itinerary';
import Elevators from '../pages/Elevators';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'points/new', element: <PointNew /> },
      { path: 'points/:id', element: <PointDetail /> },
      { path: 'routes', element: <Routes /> },
      { path: 'itinerary', element: <Itinerary /> },
      { path: 'elevators', element: <Elevators /> },
      { path: 'map', element: <MapView /> },
      { path: 'rectify', element: <Rectify /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default router;
