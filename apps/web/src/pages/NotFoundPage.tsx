import { Button, Text } from '@gravity-ui/uikit';
import { useNavigate } from 'react-router';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="cr-centered">
      <div style={{ textAlign: 'center' }}>
        <Text variant="header-2" as="h1">
          Страница не найдена
        </Text>
        <div style={{ marginTop: 16 }}>
          <Button view="action" onClick={() => navigate('/reports')}>
            К отчётам
          </Button>
        </div>
      </div>
    </div>
  );
}
