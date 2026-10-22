import { Button, Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

export function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div className="cr-centered">
      <div style={{ textAlign: 'center' }}>
        <Text variant="header-2" as="h1">
          {t('common:notFound.title')}
        </Text>
        <div style={{ marginTop: 16 }}>
          <Button view="action" onClick={() => navigate('/reports')}>
            {t('common:notFound.toReports')}
          </Button>
        </div>
      </div>
    </div>
  );
}
