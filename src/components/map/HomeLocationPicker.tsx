import React, { useEffect, useMemo } from 'react';
import { Icon, type Marker as LeafletMarker } from 'leaflet';
import {
  AttributionControl,
  MapContainer,
  Marker,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { OSM_TILE_LAYER, PIN_COLORS, maxZoom, minZoom } from './mapConfig';
import 'leaflet/dist/leaflet.css';

interface HomeLocationPickerProps {
  position: { lat: number; lng: number };
  onChange: (position: { lat: number; lng: number }) => void;
}

// A blue pin with a white house, drawn like the map's other pins (an SVG data URI)
const homePinIcon = () =>
  new Icon({
    iconUrl: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="-1 -1 26 26">` +
        `<path d="M12 23s-8-7.6-8-13a8 8 0 0 1 16 0c0 5.4-8 13-8 13z" fill="${PIN_COLORS.PRIMARY}" stroke="${PIN_COLORS.WHITE}" stroke-width="1.5"/>` +
        `<path d="M8.5 10.2 12 7.4l3.5 2.8V14h-2.3v-2.4h-2.4V14H8.5z" fill="${PIN_COLORS.WHITE}"/>` +
        `</svg>`,
    )}`,
    iconSize: [44, 44],
    iconAnchor: [22, 42],
    className: 'am-pin',
  });

// A tap on the map moves the pin there
const TapToMove = ({
  onChange,
}: {
  onChange: HomeLocationPickerProps['onChange'];
}) => {
  useMapEvents({
    click: (e) => onChange({ lat: e.latlng.lat, lng: e.latlng.lng }),
  });
  return null;
};

// Keeps the pin in view when the position changes from outside (a tap, or the location arriving)
const FollowPin = ({
  position,
}: {
  position: HomeLocationPickerProps['position'];
}) => {
  const map = useMap();
  useEffect(() => {
    if (!map.getBounds().pad(-0.2).contains([position.lat, position.lng])) {
      map.panTo([position.lat, position.lng]);
    }
  }, [map, position.lat, position.lng]);
  return null;
};

/** The small map in "Set your home location": a draggable pin, and a tap moves it */
const HomeLocationPicker: React.FC<HomeLocationPickerProps> = ({
  position,
  onChange,
}) => {
  const icon = useMemo(homePinIcon, []);
  return (
    <MapContainer
      center={[position.lat, position.lng]}
      zoom={15}
      minZoom={minZoom}
      maxZoom={maxZoom}
      zoomControl={false}
      // No default prefix (Leaflet's has a flag in yellow): the OpenStreetMap credit only, as on
      // the main map
      attributionControl={false}
      className="h-full w-full"
    >
      <AttributionControl prefix={false} />
      <TileLayer
        url={OSM_TILE_LAYER.url}
        attribution={OSM_TILE_LAYER.attribution}
      />
      <Marker
        position={[position.lat, position.lng]}
        icon={icon}
        draggable
        keyboard={false}
        eventHandlers={{
          dragend: (e) => {
            const at = (e.target as LeafletMarker).getLatLng();
            onChange({ lat: at.lat, lng: at.lng });
          },
        }}
      />
      <TapToMove onChange={onChange} />
      <FollowPin position={position} />
    </MapContainer>
  );
};

export default HomeLocationPicker;
